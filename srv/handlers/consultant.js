const cds = require('@sap/cds');
const { currentUserId } = require('../utils/user');

/* ---------------------------------------------------------
 * Closes the read side of the Consultant isolation guarantee for Ticket's
 * child entities. onReadTicket (ticket.js) already scopes /Tickets itself
 * to messageProcessor = me, but a client can query most child entities
 * directly (e.g. /TicketComments?$filter=ticket_ticketID='...') rather than
 * only via $expand — without this, that direct route would leak another
 * engineer's comments/attachments/history/SAP notes.
 * ------------------------------------------------------- */

function isConsultantOnly(req) {
    return req.user.is('Consultant') && !req.user.is('Admin');
}

async function myAssignedTicketIds(req) {
    const me = currentUserId(req);
    if (!me) return [];
    const { Ticket } = cds.entities('itsm.txn');
    const rows = await SELECT.from(Ticket).columns('ticketID').where({ messageProcessor: me });
    return rows.map(r => r.ticketID);
}

// IncidentForms, Attachments, TicketComments, ScheduledActions, TicketHistory
// all carry a direct `ticket` association (column: ticket_ticketID).
async function restrictConsultantChildByTicket(req) {
    if (!isConsultantOnly(req)) return;
    const ids = await myAssignedTicketIds(req);
    req.query.where(ids.length ? { ticket_ticketID: { in: ids } } : '1 = 0');
}

// TicketSAPNotes and SAPNoteSearchCriteria hang off IncidentForm instead
// (column: ticketForm_ID) — one hop further from Ticket than the rest.
async function restrictConsultantChildByForm(req) {
    if (!isConsultantOnly(req)) return;
    const ticketIds = await myAssignedTicketIds(req);
    if (!ticketIds.length) { req.query.where('1 = 0'); return; }

    const { IncidentForm } = cds.entities('itsm.txn');
    const forms = await SELECT.from(IncidentForm).columns('ID').where({ ticket_ticketID: { in: ticketIds } });
    const formIds = forms.map(f => f.ID);

    req.query.where(formIds.length ? { ticketForm_ID: { in: formIds } } : '1 = 0');
}

module.exports = { restrictConsultantChildByTicket, restrictConsultantChildByForm };
