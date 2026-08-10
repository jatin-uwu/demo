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

// A Consultant may update engineer/technical fields on a ticket assigned to
// them, but never routing/classification/ownership — those stay Service
// Group's and the End User's, respectively (see ITSM-Consultant-Module spec:
// "cannot reassign tickets", "cannot modify routing or classification").
const CONSULTANT_LOCKED_TICKET_FIELDS = ['reportedBy', 'ticketType', 'messageProcessor', 'supportTeam'];
const CONSULTANT_LOCKED_FORM_FIELDS = ['category1', 'category2', 'category3', 'category4', 'language', 'solutionCategory', 'recommendedPriority'];


async function beforeCreateTicket(req) {

    const data = req.data;

    data.ticketNumber = await generateTicketNumber(data.ticketType);
    data.ticketID = data.ticketNumber;

    data.status = STATUS_DRAFT;
    data.reportedBy = currentUserId(req);

    // Assignment is Service Group's job (assignTickets action), never
    // something a ticket's own creator decides — without this, a plain
    // CREATE payload could hand a brand-new ticket straight to an engineer/
    // team of the requester's choosing, bypassing triage entirely.
    if (!req.user.is('ServiceGroup') && !req.user.is('Admin')) {
        delete data.messageProcessor;
        delete data.supportTeam;
    }

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


/* ---------------------------------------------------------
 * Ownership gate for plain UPDATE, covering every role that isn't
 * unrestricted (Admin, ServiceGroup — same carve-out onReadTicket uses).
 * A Consultant may only touch a ticket already assigned to them, and only
 * its engineer/technical fields — never routing, classification or
 * ownership. Everyone else (the End User / requester case) may only touch
 * a ticket they themselves reported — otherwise a client could PATCH
 * another user's ticket by ticketID alone, since onReadTicket's own row
 * scoping only applies to READ, not UPDATE.
 *
 * Must run and finish *before* stampSlaTimestamps reads
 * req.data.messageProcessor — CAP runs same-phase `before` handlers
 * concurrently, not sequentially, so this can't be a second, separately
 * registered `before` hook (its async ownership-check query would race
 * stampSlaTimestamps rather than reliably precede it). Called directly,
 * in order, from the front of stampSlaTimestamps instead — see below.
 * ------------------------------------------------------- */
async function restrictOwnerUpdate(req) {

    if (req.user.is('Admin') || req.user.is('ServiceGroup')) return;

    const ticketID = keyOf(req, 'ticketID');
    const { Ticket } = cds.entities('itsm.txn');
    const ticket = await SELECT.one.from(Ticket).columns('messageProcessor', 'reportedBy').where({ ticketID });
    if (!ticket) return;

    if (req.user.is('Consultant')) {
        if (ticket.messageProcessor !== currentUserId(req)) {
            return req.reject(403, 'You can only update tickets assigned to you.');
        }
        for (const field of CONSULTANT_LOCKED_TICKET_FIELDS) delete req.data[field];
        if (req.data.incidentForm) {
            for (const field of CONSULTANT_LOCKED_FORM_FIELDS) delete req.data.incidentForm[field];
        }
        return;
    }

    if (ticket.reportedBy !== currentUserId(req)) {
        return req.reject(403, 'You can only update your own tickets.');
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

        if (existing) {
            data.incidentForm.ID = existing.ID;

            // Same "reuse the existing child's key so a deep update patches
            // it instead of inserting a duplicate" rule, one level deeper —
            // sapNoteSearch is a composition of *one* on incidentForm, first
            // written by the Consultant workspace (see ConsultantTicket.
            // controller.js), which never has an ID to send on the first
            // save.
            if (data.incidentForm.sapNoteSearch) {
                const existingSearch = await SELECT.one.from(cds.entities('ITSMService').SAPNoteSearchCriteria)
                    .columns('ID').where({ ticketForm_ID: existing.ID });
                if (existingSearch) data.incidentForm.sapNoteSearch.ID = existingSearch.ID;
            }
        }
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

    // Ownership check first (see restrictOwnerUpdate above) — also strips
    // a Consultant's locked fields *before* this function's own reads of
    // req.data below, so a stripped-but-still-attempted messageProcessor
    // change can never fall through into an assignedAt stamp. req.reject()
    // throws, so an unauthorized caller never reaches the rest of this
    // function.
    await restrictOwnerUpdate(req);

    const ticketID = keyOf(req, 'ticketID');
    const bStatusChanging = 'status' in req.data;
    const bAssigneeChanging = 'messageProcessor' in req.data;
    if (!ticketID || (!bStatusChanging && !bAssigneeChanging)) return;

    const { Ticket } = cds.entities('itsm.txn');
    const stored = await SELECT.one.from(Ticket)
        .columns('status', 'firstResponseAt', 'completedAt', 'messageProcessor')
        .where({ ticketID });
    if (!stored) return;

    const sNow = new Date().toISOString();

    if (bStatusChanging && req.data.status !== stored.status) {
        if (stored.status === STATUS_NEW && !stored.firstResponseAt) {
            req.data.firstResponseAt = sNow;
        }
        if (RESOLVED_STATUSES.includes(req.data.status) && !stored.completedAt) {
            req.data.completedAt = sNow;
        }
    }

    // assignedAt drives the Consultant portal's "Assigned Date" column —
    // stamped on every genuine reassignment, whether it arrives via a plain
    // PATCH or (see srv/handlers/dashboard.js) the bulk assignTickets action.
    if (bAssigneeChanging && req.data.messageProcessor !== stored.messageProcessor) {
        req.data.assignedAt = sNow;
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

    } else if (req.user.is('Consultant')) {
        // The Consultant portal's entire isolation guarantee lives here:
        // no client-side filter, no other role branch — a Consultant simply
        // never receives rows for tickets assigned to someone else.
        req.query.where(`messageProcessor = ${sql(me)}`);

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
 * so only tickets still in Draft may be deleted — and, same as
 * restrictOwnerUpdate above, only by the reporter who owns it (Admin/
 * ServiceGroup unrestricted; a Consultant never creates tickets, so has no
 * legitimate reason to delete one). Without the ownership half of this,
 * a client could DELETE another user's Draft by ticketID alone — status
 * being Draft was previously the only check.
 * ------------------------------------------------------- */
async function restrictDeleteToDrafts(req) {

    const ticketID = keyOf(req, 'ticketID');
    const { Tickets } = cds.entities('ITSMService');

    const ticket = await SELECT.one.from(Tickets)
        .columns('status', 'reportedBy').where({ ticketID });
    if (!ticket) return;

    if (ticket.status !== STATUS_DRAFT) {
        return req.reject(403, 'Only tickets still in Draft can be deleted.');
    }

    if (req.user.is('Admin') || req.user.is('ServiceGroup')) return;

    if (req.user.is('Consultant')) {
        return req.reject(403, 'Consultants cannot delete tickets.');
    }

    if (ticket.reportedBy !== currentUserId(req)) {
        return req.reject(403, 'You can only delete your own tickets.');
    }
}


function sql(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}


module.exports = { beforeCreateTicket, afterCreateTicket, onUpdateTicket, onReadTicket, onSubmitTicket, restrictDeleteToDrafts, stampSlaTimestamps };
