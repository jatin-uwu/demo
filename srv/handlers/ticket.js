const cds = require('@sap/cds');
const { generateTicketNumber } = require('../utils/ticket-number');
const { currentUserId, keyOf } = require('../utils/user');
const { captureAggregate, logAggregateChanges, logField } = require('../utils/history');

const STATUS_DRAFT = 'DRAFT';
// Our first "active" status once a ticket leaves Draft. The reference repo's
// own example only has DRAFT -> OPEN; we keep our richer status vocabulary
// (NEW, IN_PROCESS, CUSTOMER_ACTION, SOLUTION_PROPOSED, CONFIRMED, CLOSED —
// see db/data/itsm.master-LookupValue.csv) since `status` is an unconstrained
// String(50) in both schemas, not an enum.
const STATUS_NEW = 'NEW';

// SLA stamping — additive, not in the reference repo (their example has no
// SLA logic yet). Ported from our own previous service.js: firstResponseAt
// is stamped the first time a ticket leaves NEW; completedAt the first time
// it reaches CONFIRMED or CLOSED. Both are set once only.
const RESOLVED_STATUSES = ['CONFIRMED', 'CLOSED'];

const SYSTEM_FIELDS = [
    'ticketID', 'ticketNumber', 'reportedBy',
    'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
];


async function beforeCreateTicket(req) {

    const data = req.data;

    data.ticketNumber = await generateTicketNumber(data.ticketType);
    data.ticketID = data.ticketNumber;

    data.status = STATUS_DRAFT;
    data.reportedBy = currentUserId(req);

    if (Array.isArray(data.comments) && data.comments.length) {
        const author = currentUserId(req);
        for (const comment of data.comments) {
            if (!comment.author) comment.author = author;
        }
    }
}


/* ---------------------------------------------------------
 * afterCreateTicket — additive: writes the first TicketHistory
 * row so the timeline has a "Ticket Created" entry to start
 * from, same as our previous service.js did. The reference's
 * TicketHistory has no changeType column, so this reuses the
 * plain field-change log (status: null -> DRAFT) instead of a
 * separate concept — the frontend's history formatters treat
 * that specific shape as "created".
 * ------------------------------------------------------- */
async function afterCreateTicket(data, req) {
    // CAP passes an array here (even for a single CREATE), and each row
    // only carries its key — not the rest of the persisted fields — so
    // the known STATUS_DRAFT constant is used directly rather than reading
    // back a (missing) data.status.
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
        await logField(req, row.ticketID, 'status', null, STATUS_DRAFT);
    }
}


async function onUpdateTicket(req, next) {

    const data = req.data;
    const ticketID = keyOf(req, 'ticketID');

    for (const field of SYSTEM_FIELDS) delete data[field];

    // submitTicket() is the only door out of Draft (see service.cds) — a
    // plain PATCH is refused specifically for that one transition. Once a
    // ticket is active, status moves freely through the rest of our
    // lifecycle (New -> In Process -> ... -> Closed) via ordinary UPDATE,
    // same as before this rewrite.
    if ('status' in data && ticketID) {
        const current = await SELECT.one.from(cds.entities('itsm.txn').Ticket)
            .columns('status').where({ ticketID });
        if (current && current.status === STATUS_DRAFT) {
            return req.reject(400, 'Use submitTicket() to move a ticket out of Draft.');
        }
    }

    if (data.incidentForm && ticketID) {
        const existing = await SELECT.one.from(cds.entities('ITSMService').IncidentForms)
            .columns('ID').where({ ticket_ticketID: ticketID });

        if (existing) data.incidentForm.ID = existing.ID;
    }

    if (Array.isArray(data.comments) && data.comments.length) {
        const author = currentUserId(req);
        for (const comment of data.comments) {
            if (!comment.author) comment.author = author;
        }
    }

    await captureAggregate(req);

    const result = await next();

    await logAggregateChanges(req);

    return result;
}


async function stampSlaTimestamps(req) {

    const ticketID = keyOf(req, 'ticketID');
    if (!ticketID || !('status' in req.data)) return;

    const { Ticket } = cds.entities('itsm.txn');
    const stored = await SELECT.one.from(Ticket)
        .columns('status', 'firstResponseAt', 'completedAt')
        .where({ ticketID });

    if (!stored || req.data.status === stored.status) return;

    const sNow = new Date().toISOString();

    if (stored.status === STATUS_NEW && !stored.firstResponseAt) {
        req.data.firstResponseAt = sNow;
    }

    if (RESOLVED_STATUSES.includes(req.data.status) && !stored.completedAt) {
        req.data.completedAt = sNow;
    }
}


async function onReadTicket(req, next) {

    const me = currentUserId(req);

    if (req.user.is('Admin')) {

    } else if (!me) {
        req.query.where('1 = 0');

    } else if (req.user.is('ServiceGroup')) {
        req.query.where(
            `(status != ${sql(STATUS_DRAFT)} or status is null)`
            + ` or reportedBy = ${sql(me)}`
        );

    } else {
        req.query.where(`reportedBy = ${sql(me)}`);
    }

    return next();
}


async function onSubmitTicket(req) {

    const ticketID = keyOf(req, 'ticketID');
    if (!ticketID) return req.reject(400, 'No ticket to submit.');

    const { Tickets } = cds.entities('ITSMService');
    const ticket = await SELECT.one.from(Tickets)
        .columns('ticketID', 'status', 'reportedBy')
        .where({ ticketID });

    if (!ticket) return req.reject(404, `Ticket ${ticketID} not found.`);

    if (ticket.status !== STATUS_DRAFT) {
        return req.reject(400,
            `Only a draft can be submitted (this ticket is ${ticket.status || 'unset'}).`);
    }

    if (ticket.reportedBy !== currentUserId(req)) {
        return req.reject(403, 'Only the reporter of a ticket can submit it.');
    }

    await UPDATE(cds.entities('itsm.txn').Ticket)
        .set({ status: STATUS_NEW })
        .where({ ticketID });

    await logField(req, ticketID, 'status', STATUS_DRAFT, STATUS_NEW);

    return SELECT.one.from(Tickets).where({ ticketID });
}


/* ---------------------------------------------------------
 * DELETE — additive, not in the reference repo (it has no
 * DELETE hook yet). A ticket that has left Draft is part of
 * the recorded process flow (history, SLA clocks, attachments),
 * so only tickets still in Draft may be deleted.
 * ------------------------------------------------------- */
async function restrictDeleteToDrafts(req) {

    const ticketID = keyOf(req, 'ticketID');
    const { Tickets } = cds.entities('ITSMService');

    const ticket = await SELECT.one.from(Tickets)
        .columns('status').where({ ticketID });

    if (ticket && ticket.status !== STATUS_DRAFT) {
        req.reject(403, 'Only tickets still in Draft can be deleted.');
    }
}


function sql(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}


module.exports = { beforeCreateTicket, afterCreateTicket, onUpdateTicket, onReadTicket, onSubmitTicket, restrictDeleteToDrafts, stampSlaTimestamps };
