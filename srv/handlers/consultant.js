const cds = require('@sap/cds');
const { currentUserId, keyOf } = require('../utils/user');

/* ---------------------------------------------------------
 * Ownership scoping shared by every non-privileged role — the read-side
 * counterpart of onReadTicket's own /Tickets scoping (ticket.js), applied
 * to Ticket's child entities and to standalone writes on entities that
 * aren't locked read-only by @Capabilities (currently just Attachments).
 *
 * Without this, a client could bypass /Tickets' own row scoping entirely
 * by querying a child entity directly (e.g.
 * /TicketComments?$filter=ticket_ticketID='INC-1002') or by POSTing an
 * Attachment against a ticket outside their scope — the parent entity
 * being scoped says nothing about its children unless each one re-checks
 * independently.
 *
 * Returns null for roles with unrestricted visibility (Admin,
 * ServiceGroup — same as onReadTicket), otherwise the {field, value} an
 * owning Ticket row must match: messageProcessor = me for a Consultant,
 * reportedBy = me for everyone else (the End User / requester case).
 * ------------------------------------------------------- */
function ownerScope(req) {
    if (req.user.is('Admin') || req.user.is('ServiceGroup')) return null;
    const me = currentUserId(req);
    if (req.user.is('Consultant')) return { field: 'messageProcessor', value: me };
    return { field: 'reportedBy', value: me };
}

// Ticket IDs the caller is allowed to see/touch, or null when unrestricted.
async function myScopedTicketIds(req) {
    const scope = ownerScope(req);
    if (!scope) return null;
    if (!scope.value) return [];

    const { Ticket } = cds.entities('itsm.txn');
    const rows = await SELECT.from(Ticket).columns('ticketID').where({ [scope.field]: scope.value });
    return rows.map(r => r.ticketID);
}

// IncidentForms, Attachments, TicketComments, ScheduledActions, TicketHistory
// all carry a direct `ticket` association (column: ticket_ticketID).
async function restrictChildByTicket(req) {
    const ids = await myScopedTicketIds(req);
    if (ids === null) return; // Admin / ServiceGroup — unrestricted
    req.query.where(ids.length ? { ticket_ticketID: { in: ids } } : '1 = 0');
}

// TicketSAPNotes and SAPNoteSearchCriteria hang off IncidentForm instead
// (column: ticketForm_ID) — one hop further from Ticket than the rest.
async function restrictChildByForm(req) {
    const ids = await myScopedTicketIds(req);
    if (ids === null) return;
    if (!ids.length) { req.query.where('1 = 0'); return; }

    const { IncidentForm } = cds.entities('itsm.txn');
    const forms = await SELECT.from(IncidentForm).columns('ID').where({ ticket_ticketID: { in: ids } });
    const formIds = forms.map(f => f.ID);

    req.query.where(formIds.length ? { ticketForm_ID: { in: formIds } } : '1 = 0');
}

/* ---------------------------------------------------------
 * Write-side counterpart, for entities writable standalone (not only as
 * part of a Ticket deep update) — currently just Attachments; every other
 * child entity is locked Insertable:false in service.cds. Rejects a
 * CREATE/UPDATE/DELETE against a ticket outside the caller's ownerScope,
 * the same rule restrictChildByTicket enforces for reads.
 * ------------------------------------------------------- */
async function restrictAttachmentWrite(req) {
    const scope = ownerScope(req);
    if (!scope) return; // Admin / ServiceGroup — unrestricted

    let ticketID;
    if (req.event === 'CREATE') {
        ticketID = req.data.ticket_ticketID;
    } else {
        const { Attachment } = cds.entities('itsm.txn');
        const id = keyOf(req, 'ID');
        const row = id && await SELECT.one.from(Attachment).columns('ticket_ticketID').where({ ID: id });
        ticketID = row && row.ticket_ticketID;
    }

    if (!ticketID) return req.reject(400, 'ticket reference is required.');

    const { Ticket } = cds.entities('itsm.txn');
    const ticket = await SELECT.one.from(Ticket).columns(scope.field).where({ ticketID });
    if (!ticket || ticket[scope.field] !== scope.value) {
        return req.reject(403, 'You are not authorized for this ticket.');
    }
}

module.exports = { restrictChildByTicket, restrictChildByForm, restrictAttachmentWrite };
