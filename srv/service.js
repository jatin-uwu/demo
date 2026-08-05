const cds = require('@sap/cds');

const { beforeCreateTicket, afterCreateTicket, onUpdateTicket, onReadTicket, onSubmitTicket, restrictDeleteToDrafts, stampSlaTimestamps } = require('./handlers/ticket');
const { onCurrentUser, onAssignTickets } = require('./handlers/dashboard');

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

   No child entity has a hook. That is not a stylistic choice: a
   nested composition raises NO CREATE or UPDATE event of its
   own — CAP writes child rows as part of the parent's statement
   — so a hook on TicketComments would never fire for a comment
   that arrived inside a ticket payload. Child enrichment happens
   inline in the ticket handlers instead.

   No business logic belongs in this file.
   ========================================================= */

module.exports = cds.service.impl(async function () {

    const { Tickets } = this.entities;


    this.before('CREATE', Tickets, beforeCreateTicket);
    this.before('UPDATE', Tickets, stampSlaTimestamps);
    this.on('UPDATE', Tickets, onUpdateTicket);
    this.on('READ', Tickets, onReadTicket);
    this.before('DELETE', Tickets, restrictDeleteToDrafts);
    this.after('CREATE', Tickets, afterCreateTicket);

    this.on('submitTicket', onSubmitTicket);
    this.on('currentUser', onCurrentUser);
    this.on('assignTickets', onAssignTickets);

});
