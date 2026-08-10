# Current Status — ITSM Incident Management

Snapshot date: 2026-08-09. This is a handover snapshot for continued
development, not a permanent record — update or delete it once the next
phase of work starts.

## What has been completed

- **Domain model** (`db/schema.cds`): master data context (lookup values,
  users, support teams, systems, software components, configuration items)
  and transactional context (`Ticket` as aggregate root, with `IncidentForm`,
  `Attachment`, `TicketComment`, `TicketHistory`, `TicketTransaction`,
  `ScheduledAction`, `TicketSAPNote`, `SAPNoteSearchCriteria` as children).
- **Service layer** (`srv/service.cds` + `srv/handlers/*.js`):
  - Ticket create → Draft, with server-generated ticket number
    (`srv/utils/ticket-number.js`, atomic per-prefix counter)
  - `submitTicket` action as the sole Draft → New transition (plain PATCH is
    rejected for that specific move)
  - Ticket update: deep update of ticket + children in one flow, SLA
    timestamp stamping (`firstResponseAt`, `completedAt`, `assignedAt`)
  - Ticket delete: restricted to Draft-status tickets only
  - Role-based READ scoping on `Tickets` and enforced again on every child
    entity individually (so direct child-entity queries can't bypass it)
  - Consultant field-level locking (routing/classification/ownership fields
    stripped from a Consultant's update payload server-side)
  - `assignTickets` bulk (re)assignment action for Service Group, with audit
    history
  - `currentUser()` function returning identity + role flags for the UI
  - Append-only `TicketHistory` audit log, written by handlers only
- **Frontend** (`app/webapp`): six persona-specific screens (see README —
  Requester, Service Desk, Consultant, each with dashboard + working views),
  routed via `manifest.json`, backed by the OData V4 service.
- **Sample/demo data** (`db/data/*.csv`): lookup values for all vocabularies
  (status, priority, impact, urgency, category tree, ticket type), 6 demo
  users mapped to the mocked local logins, sample support teams, systems,
  components, configuration items, and a few example tickets.
- **Cloud deployment scaffolding**: `mta.yaml` (CAP service + HDI deployer +
  approuter modules), `xs-security.json` (Agent/ServiceGroup/Admin/Consultant
  scopes and role collections), CF-specific PostgreSQL TLS handling in
  `srv/server.js`.

## What is currently working

- Local dev loop via `cds watch` on SQLite with mocked auth (5 test users
  covering Agent, Consultant and ServiceGroup roles) — this is the verified,
  day-to-day working setup.
- End-to-end ticket flow: Requester creates + submits a ticket → Service
  Group sees it in their queue and assigns an engineer/team → Consultant sees
  it in "My Queue" and updates it → status/SLA timestamps and history update
  correctly through that flow.
- Role-based visibility, verified for all three main personas including
  direct child-entity access (not just `$expand`).

## What is partially implemented

- **Admin persona**: has scopes/roles defined (`xs-security.json`,
  `package.json` mocked users list has no dedicated `admin` user yet) and
  full CRUD is technically reachable via the OData API, but there is no
  dedicated Admin UI/screen for master data maintenance.
- **Production database path**: HANA and PostgreSQL profiles are declared
  and dependencies installed, but only SQLite has been exercised in this
  environment — the HANA/Postgres path is unverified end-to-end here.
- **Approuter / production routing**: `app/xs-app.json` and `mta.yaml` are in
  place, but see Known Issues below — the OData proxy path needs a fix
  before this route actually works.

## What still needs to be developed

- Dedicated Admin UI for master data (lookup values, users, support teams,
  systems, components, configuration items) — currently API-only.
- Automated tests (none currently in the project — no `test/` folder or test
  script).
- Verification of the HANA/XSUAA cloud path end-to-end (deploy, bind, log in
  with a real XSUAA user/role collection).
- Decide on and implement `ScheduledAction` and `TicketTransaction` UI, if
  they're meant to be user-facing — schema and read restrictions exist for
  them, but no screen currently creates/edits them.

## Important technical decisions already made

- **Aggregate-root architecture**: `Ticket` is the only entity with
  lifecycle hooks; every child entity is written as part of the ticket's own
  deep insert/update, never independently — see the header comment in
  `srv/service.js` for the full rationale.
- **No `@odata.draft.enabled`**: Draft/New is modeled as a plain status value
  plus a dedicated `submitTicket` action, not CAP's built-in draft handling.
- **Role checks are server-side only** (`req.user.is(...)` + query `where`
  scoping in the handlers) — the UI must not be trusted as the access-control
  boundary, and any new screen/query needs its own server-side check, not
  just a client-side filter.
- **Ticket keys are business ticket numbers** (`ticketID`/`ticketNumber`,
  `String(30)`), not UUIDs — generated atomically per ticket-type prefix via
  `srv/utils/ticket-number.js`.
- **Master data referenced by plain code/id, not CDS associations** (e.g.
  `Ticket.supportTeam` is a `String(50)` team code, not an association to
  `SupportTeam`) — a deliberate simplification over an earlier association-
  based version of the schema.

## Known issues / errors

- `app/xs-app.json`'s OData route source is `^/odata/v4/incident/(.*)$`, but
  the service is actually mounted at `/odata/v4/ITSMService/` (`@path:
  'ITSMService'` in `srv/service.cds`). Under the approuter, OData calls will
  currently 404. **Not an issue in the primary local dev path** (`cds watch`
  serves UI and OData together, bypassing the approuter entirely) — only
  matters once someone runs the approuter/production routing.
- No automated test coverage — regressions can currently only be caught
  manually.
- `sqlite.db` is a local, seeded working database (git-ignored, has local
  uncommitted state) — it is **excluded** from this handover ZIP; the
  recipient should let `cds watch` recreate/seed it from `db/data/*.csv` on
  first run rather than expecting a pre-populated one.

## Recommended next steps

1. Fix the `xs-app.json` OData route path (or update `service.cds`'s `@path`
   to match it, whichever is intended) so the approuter path works.
2. Decide whether Admin gets a real UI or stays API-only for now.
3. Add at least basic integration tests around the Draft → Submit → Assign →
   Resolve flow, since that's the core business flow and currently has no
   safety net.
4. Verify the HANA (or Postgres) + XSUAA path on an actual BTP space before
   relying on `mta.yaml` for a real deployment.
