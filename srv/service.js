const cds = require('@sap/cds');

const { beforeCreateTicket, afterCreateTicket, onUpdateTicket, onReadTicket, onSubmitTicket, restrictDeleteToDrafts, stampSlaTimestamps } = require('./handlers/ticket');
const { onCurrentUser, onAssignTickets } = require('./handlers/dashboard');
const { restrictChildByTicket, restrictChildByForm, restrictAttachmentWrite } = require('./handlers/consultant');

/* =========================================================
   ITSM SERVICE — AGGREGATE ROOT ARCHITECTURE

   Ticket is the root. Every other business entity is a
   composition child of it and is written as part of its ticket,
   so Ticket is the only entity with lifecycle hooks:

       Ticket                      <- hooks live here
         ├── incidentForm
         │     ├── sapNotes
         │     └── sapNoteSearch
         ├── comments
         ├── attachments
         ├── scheduledActions
         ├── transactions
         └── history

   Seven registrations: three CRUD hooks on Tickets, a DELETE
   guard, plus one per custom operation.

     CREATE        generate IDs + enrich the whole aggregate
     UPDATE        deep update, ticket + children, one flow
     READ          role-based visibility (own / queue / all)
     DELETE        only a Draft may be deleted (our own addition —
                   the reference repo has no DELETE hook yet)
     submitTicket  the only DRAFT -> NEW door
     currentUser   the caller's identity and role flags
     assignTickets service-group bulk (re)assignment

   Child entities normally have no hook of their own: a nested
   composition raises NO CREATE or UPDATE event of its own — CAP
   writes child rows as part of the parent's statement — so a
   hook on TicketComments would never fire for a comment that
   arrived inside a ticket payload. Child enrichment happens
   inline in the ticket handlers instead.

   The one exception is READ: unlike CREATE/UPDATE, a client can
   (and the Consultant/End User portals' own attachments/comments/
   history panels do) query a child entity directly rather than
   only through $expand on Tickets. restrictChildByTicket/ByForm
   close the read side of that gap for every non-privileged role
   (Consultant scoped to messageProcessor = me, everyone else to
   reportedBy = me) — see srv/handlers/consultant.js.

   No business logic belongs in this file.
   ========================================================= */

module.exports = cds.service.impl(async function () {

    const { Tickets, IncidentForms, Attachments, TicketComments,
        TicketSAPNotes, SAPNoteSearchCriteria, ScheduledActions, TicketHistory } = this.entities;


    this.before('CREATE', Tickets, beforeCreateTicket);
    // stampSlaTimestamps runs restrictConsultantUpdate itself, first thing —
    // see the comment on restrictConsultantUpdate in handlers/ticket.js for
    // why these can't be two independently registered `before` hooks.
    this.before('UPDATE', Tickets, stampSlaTimestamps);
    this.on('UPDATE', Tickets, onUpdateTicket);
    this.on('READ', Tickets, onReadTicket);
    this.before('DELETE', Tickets, restrictDeleteToDrafts);
    this.after('CREATE', Tickets, afterCreateTicket);

    this.on('submitTicket', onSubmitTicket);
    this.on('currentUser', onCurrentUser);
    this.on('assignTickets', onAssignTickets);

    // Ticket's own child entities — reachable directly, not only via
    // $expand, so each needs the same ownership check as Tickets itself.
    for (const entity of [IncidentForms, Attachments, TicketComments, ScheduledActions, TicketHistory]) {
        this.before('READ', entity, restrictChildByTicket);
    }
    for (const entity of [TicketSAPNotes, SAPNoteSearchCriteria]) {
        this.before('READ', entity, restrictChildByForm);
    }

    // Attachments is the one child entity still writable standalone (every
    // other one is locked Insertable:false in service.cds) — guard its
    // write side by the same ownership scope, so a client can't attach a
    // file to (or edit/remove one from) a ticket outside their own scope.
    this.before(['CREATE', 'UPDATE', 'DELETE'], Attachments, restrictAttachmentWrite);

});
