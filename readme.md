# ITSM — Incident & Ticket Management System

An IT Service Management (ITSM) application for logging, routing and
resolving incidents, built on **SAP CAP** (backend) and **SAPUI5** (frontend).
It supports three personas — **End User / Requester**, **Service Desk /
Service Group**, and **Consultant / Engineer** — each with its own screens
and its own view of the ticket queue.

## Project purpose

Replace ad-hoc/manual incident tracking with a structured flow: a requester
raises a ticket, the service desk classifies and assigns it to an engineer
or team, the engineer investigates and resolves it, and every step is
captured in an auditable history with SLA timestamps.

## Technology stack

| Layer | Technology |
|---|---|
| Backend | SAP CAP (Node.js), `@sap/cds` 10 |
| Frontend | SAPUI5 / Fiori-style freestyle app (XML views + JS controllers), OData V4 |
| Database (dev) | SQLite (file: `sqlite.db`, via `@cap-js/sqlite`) |
| Database (prod options) | SAP HANA (`@cap-js/hana`) or PostgreSQL (`@cap-js/postgres`) |
| Auth (local) | CAP mocked auth (users defined in `package.json`) |
| Auth (cloud) | SAP XSUAA (`xs-security.json`), via `@sap/xssec` |
| Deployment | Cloud Foundry / SAP BTP via MTA (`mta.yaml`), with `@sap/approuter` as the entry point |

## Current project structure

```
.
├── app/                          Frontend (SAPUI5) + approuter
│   ├── webapp/
│   │   ├── controller/           App controllers, one per screen/persona
│   │   │   ├── Main.controller.js              Create/edit ticket (requester form)
│   │   │   ├── Dashboard.controller.js          Requester's "My Tickets" dashboard
│   │   │   ├── ServiceGroupDashboard.controller.js  Service desk KPI dashboard
│   │   │   ├── ServiceGroupTickets.controller.js    Service desk queue + assignment
│   │   │   ├── AssignedTickets.controller.js        Consultant's "My Queue"
│   │   │   └── ConsultantTicket.controller.js       Consultant's ticket workspace
│   │   ├── view/                 XML views matching the controllers above
│   │   ├── i18n/                 UI text bundle
│   │   ├── css/                  Custom styling
│   │   ├── images/               App assets (logo)
│   │   ├── Component.js          UI5 component bootstrap
│   │   ├── index.html            App entry point
│   │   └── manifest.json         UI5 app descriptor (routes, OData model, libs)
│   ├── xs-app.json                Approuter routing (UI + OData proxy)
│   └── package.json               Approuter dependencies
│
├── db/                            Domain model + sample data
│   ├── schema.cds                 CDS entities (master data + transactional)
│   ├── data/                      CSV seed/sample data (master + demo tickets)
│   └── undeploy.json
│
├── srv/                           Service layer
│   ├── service.cds                OData service definition (entities, actions, roles)
│   ├── service.js                 Registers all event handlers (no business logic here)
│   ├── server.js                  CAP bootstrap (Cloud Foundry PostgreSQL TLS fix-up)
│   └── handlers/
│       ├── ticket.js              Ticket CRUD lifecycle, SLA stamping, submit, role-based read
│       ├── dashboard.js           currentUser() + assignTickets() bulk assignment
│       └── consultant.js          Read-side isolation for Consultant child entities
│   └── utils/
│       ├── ticket-number.js       Atomic per-prefix ticket numbering
│       ├── user.js                Current-user / role helpers
│       └── history.js             Field-change audit logging
│
├── package.json                   Root CAP project (dependencies + mocked users + db profiles)
├── package-lock.json
├── mta.yaml                       Cloud Foundry deployment descriptor
├── xs-security.json               XSUAA role/scope definitions
├── .cdsrc-private.json            Local-only hybrid HANA binding config (gitignored, not shared)
├── README.md                      This file
└── CURRENT_STATUS.md              Snapshot of what's done / in progress / known issues
```

## Personas and their responsibilities

| Persona | Role (mocked/XSUAA) | Screens | Responsibilities |
|---|---|---|---|
| **End User / Requester** | any authenticated user | `Dashboard`, `Main` (create/edit ticket) | Raises incidents, fills the incident form, submits a Draft ticket, tracks their own tickets' status. Sees only tickets they reported. |
| **Support Team / Service Desk** | `Agent`, `ServiceGroup` | `ServiceGroupDashboard`, `ServiceGroupTickets` | Sees every non-draft ticket (plus their own drafts), classifies/triages, and bulk-assigns tickets to an engineer and/or support team via the `assignTickets` action. Cannot see other users' drafts. |
| **Consultant / Engineer** | `Consultant` | `AssignedTickets`, `ConsultantTicket` | Works only tickets currently assigned to them (`messageProcessor = me`, enforced server-side on every entity, not just `Tickets`). Can update engineer/technical fields only — routing, classification and ownership fields are locked server-side. |
| **Admin** | `Admin` | (master data, via API/CRUD) | Full access; maintains lookup values, users, support teams, systems, components and configuration items. |

Role checks are enforced **server-side** in `srv/handlers/*.js` (via
`req.user.is(...)` and query-level `where` scoping) — the UI does not decide
visibility on its own.

## Installing dependencies

From the project root:

```bash
npm install
```

The approuter (only needed if you plan to run the production-style routed
setup) has its own dependencies:

```bash
cd app
npm install
```

## Running the project locally (recommended: SQLite + mocked auth)

The simplest local setup uses the bundled SQLite database and CAP's mocked
authentication (test users are defined in `package.json` under
`cds.requires.auth.users` — e.g. `virat` / `welcome1` with role `Consultant`).

From the project root:

```bash
cds watch
```

This compiles the CDS model, deploys/seeds `sqlite.db` from `db/data/*.csv`
as needed, starts the CAP server, and serves the SAPUI5 app together with it
— there is no separate step to "start" the UI5 app in this mode. Open:

```
http://localhost:4004
```

and sign in with one of the mocked users below.

### Mocked local users

| User | Password | Role |
|---|---|---|
| sachin | welcome1 | Agent |
| aayush | welcome1 | Agent |
| sarthak | welcome1 | Agent |
| virat | welcome1 | Consultant |
| jatin | welcome1 | ServiceGroup |

These are local-only, low-privilege CAP mock-auth test credentials (not real
secrets) and only work when `cds watch`/`cds-serve` runs with the `auth.kind:
mocked` config already in `package.json`. They are **not** valid against any
real XSUAA/BTP environment.

## Starting the CAP server explicitly

If you don't want `cds watch`'s file-watching/reload behaviour:

```bash
npm start
```

(equivalent to `cds-serve`).

## Starting the UI5 application

In local dev (`cds watch` / `npm start`), the UI5 app under `app/webapp` is
served automatically by the CAP server — no separate command is needed;
just browse to `http://localhost:4004`.

To run the UI behind the production-style approuter instead (proxying to a
separately running CAP server):

```bash
cd app
npm install
npm start
```

See **Known issues** in `CURRENT_STATUS.md` — the approuter's OData route in
`xs-app.json` currently points at a path that doesn't match the service's
actual mount point, so this path needs a fix before it will proxy correctly.

## Environment variables / configuration

Local SQLite + mocked-auth development needs **no environment variables** —
everything required is already in `package.json` (`cds.requires`).

For cloud/hybrid profiles, see `.env.example` at the project root for the
variables a `.env` file would need (this file intentionally contains
placeholders only — get real values from whoever manages the BTP
subaccount/space).

Cloud deployment additionally needs, via `mta.yaml`/Cloud Foundry service
bindings (not `.env`):

- An HDI container binding for HANA (`FORM_demo-db`)
- An XSUAA service binding (`FORM_demo-auth`), configured from `xs-security.json`

## Current implemented functionality

- Ticket creation as a **Draft**, with a persona-specific incident form
  (category tree, impact/urgency, priority recommendation, SAP notes search,
  attachments, comments)
- `submitTicket` action as the single Draft → New transition
- Full ticket lifecycle status updates (New → In Process → Customer Action →
  Solution Proposed → Confirmed → Closed) via plain OData UPDATE
- SLA timestamp stamping (`firstResponseAt`, `completedAt`, `assignedAt`)
- Role-based read visibility on `Tickets` and all of its child entities
  (Requester sees own tickets; Service Group sees all active tickets;
  Consultant sees only tickets assigned to them)
- Field-level locking for Consultants (cannot touch routing/classification/
  ownership fields)
- Bulk ticket (re)assignment to an engineer and/or support team
  (`assignTickets` action), with audit history
- Append-only `TicketHistory` audit trail on every field change, submit, and
  assignment
- File attachments (metadata row + streamed binary content)
- Comments thread per ticket
- Requester dashboard, Service Group dashboard (with KPIs/trends) and
  Consultant "My Queue" dashboard/table views
- Master data: lookup values (status/priority/impact/urgency/category/
  ticket type), users, support teams, systems, software components,
  configuration items — seeded with sample data in `db/data/`

## Known limitations / remaining work

See `CURRENT_STATUS.md` for the full, current breakdown. Headline items:

- `app/xs-app.json`'s OData proxy route path does not match the service's
  actual `/odata/v4/ITSMService/` mount point — needs reconciling before the
  approuter/production routing path is usable
- No automated tests yet
- Admin persona has no dedicated UI (master data is CRUD-only via the API)
- Production HANA/XSUAA path is defined (`mta.yaml`, `xs-security.json`) but
  not yet deployed/verified end-to-end

## Useful commands

| Command | Purpose |
|---|---|
| `npm install` | Install root (CAP) dependencies |
| `cds watch` | Run CAP server + UI in watch/reload mode (recommended for dev) |
| `npm start` | Run CAP server once (`cds-serve`), no watch |
| `cd app && npm install && npm start` | Run the standalone approuter (production-style routing) |
| `cds build --production` | Build production artifacts (used by `mta.yaml`) |

## Learn more

- SAP CAP: <https://cap.cloud.sap>
