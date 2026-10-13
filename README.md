# Onixus Logistics OS

Trucking TMS. Drayage (containers) is the core; flatbed, dry van, box truck
and cargo van loads run through the same loads, dispatch and billing flow.
One authenticated API over swappable providers, the database schema, and the
dispatcher web app.

## Who uses it

Every business is an organization, from an owner-operator with one cargo van
to a drayage fleet. People sign in (Supabase Auth) and get one role:

| Role | Sees |
|---|---|
| Owner | Everything, plus Team (invite and remove people) |
| Dispatcher | Loads, dispatch, containers, fleet, customers |
| Driver | The driver app: their own trips only |

An owner-operator is an organization of one: an owner linked to a driver
record, with both the office and "My trips". Each organization sees only
its own data; the API scopes every query to the caller's organization.

**Driver app** (phone-sized): start the trip, tap each stop (arrived,
picked up, arrived at delivery, delivered), open directions, check in with
the phone's location, and photograph the proof of delivery, which moves
the load to "POD received" for billing.

## Drayage first

**Delivery orders in, loads out.** Upload the delivery order or booking
(PDF or photo) or paste the email; the AI model reads it (customer, steamship
line, B/L, pickup number, vessel and ETA, terminal, last free day, consignee,
every container with size, type, weight and seal); any of the AI providers
can read it, and OpenRouter keeps it cheap. You check the draft,
mistyped container numbers are flagged by their check digit, and one load per
container is created and booked, with the customer, line, terminal and
delivery site matched to what you already have or added.

**Moves are legs.** Each container move is planned as legs when the load is
booked: import live unload, drop & pick, prepull to your yard, export live
load or drop, with empties back to the terminal or a depot of your choice.
Dispatch puts legs on trips (a live unload is both legs on one trip; a drop
sends the empty later), drivers tap through each leg in order, and the load's
status, out-gate (starts per diem), empty return and export in-gate (stop it)
follow. Each leg carries its terminal appointment. Approving a street turn
cancels the import's empty trip and sends the export's empty from the
consignee.

## What it does

| Area | What you get |
|---|---|
| Loads | One load board for every kind of freight. Container loads carry container #, size/type, line, booking, LFD, cutoff; other freight carries commodity, weight, pallets, dimensions, hazmat, flatbed securement and permits. Container fields are refused on other freight (API and database). |
| Container numbers | ISO 6346 check digit, so a mistyped container is caught at entry, not at the gate. |
| Lifecycle | Draft → booked → assigned → dispatched → picked up → delivered → invoiced → settled, with every move logged. Booking checks the facts each kind of load needs. |
| Dispatch | Assigns loads to a driver, truck and trailer only when they fit: tractor + chassis for containers (pool chassis optional), tractor + flatbed or dry van trailer, box truck, cargo van (or box truck). Checks chassis size, payload, CDL class (A for tractors, B for heavy box trucks), medical card, hazmat endorsement and TWIC for port work. Two containers make a dual transaction. |
| Container clocks | Demurrage after the last free day, per diem after free time, vessel cutoffs; an alerts board ranked by money at risk. |
| Street turns | Finds emptied imports near exports on the same line, size and type; propose, then record the line's approval. |
| Port data | Signed webhook that updates terminal availability, holds, fees and the LFD on open imports. |
| FMCSA | Checks a broker or carrier's authority, safety rating and insurance; daily re-check endpoint. |
| Rates and billing | Lane tariffs (customer-specific first, fuel surcharge as a percent); invoices with line haul, accessorials, demurrage and per diem. |
| Drayage extras | Chassis days, prepull, yard storage, waiting time, overweight and hazmat, worked out from each move's clocks and legs and priced from the company's rate card. Suggested on every invoice; the dispatcher can edit or drop them. |
| Overview | The office dashboard: where loads are, money accruing on containers, moves per day, legs without a truck, and what needs attention. |
| GPS | Live truck positions from Traccar. |

### Built on open source, not rebuilt

We looked for an open-source TMS to adopt instead of building this. None
fits: Trenova's license forbids offering it as a hosted service or a
competing product, logistics-app is non-commercial only, and the MIT-licensed
Open TMS has no container or equipment model. So the freight rules here are
our own, and the parts that already exist as open source are used as is:

- **Traccar** (Apache 2.0) for GPS: self-hosted server (`docker-compose`
  runs one) and the free Traccar Client phone app for drivers.
- **FMCSA QCMobile**, the free government carrier API.
- **PostGIS** for locations.

## Providers

Pick each provider with one environment variable. Switching is a config
change, never a code change.

| Capability | Variable | Options |
|---|---|---|
| Email | `EMAIL_PROVIDER` | `gmail`, `microsoft` (Outlook.com, Outlook and Microsoft 365; alias `outlook`), `onyx` (Onyx Mail, coming soon) |
| CRM | `CRM_PROVIDER` | `hubspot`, `onyx` (Onyx CRM, coming soon) |
| AI model | `LLM_PROVIDER` | `claude` (default `claude-opus-5-5`), `openai`, `onyx` (OpenAI-compatible endpoint), `openrouter` (one key, many models; default `google/gemini-2.5-flash`, low cost) |
| Database | `DATABASE_PROVIDER` | `supabase` |
| GPS tracking | `TRACKING_PROVIDER` | `traccar`, `samsara` (coming soon), `motive` (coming soon) |

A "coming soon" provider can be selected and answers `501 Not Implemented`;
nothing returns a fake success. A selected provider with missing credentials
answers `503` naming the variables to set, and the web app's Connections page
shows the same.

## Run locally

```bash
cp .env.example .env        # set TMS_API_KEY and the providers you use
npm install
npm run dev                 # API on :4000, web app on :5173
```

Open http://localhost:5173, create an account and set up your business.
Sign-in needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. In Supabase,
Authentication → URL Configuration must list the web app's address as the
Site URL (invite, confirmation and reset links go there), and "Confirm
email" stays on: invitations are matched to people by their confirmed email.

```bash
npm test                    # API + provider tests
npm run typecheck
npm run build               # web app → apps/web/dist
```

## API

Every route except `/health` and the signed port webhook needs
`Authorization: Bearer <token>`: a signed-in person's Supabase access token,
or the platform key (`TMS_API_KEY`, plus `X-Org-Id` to act inside one
company). Email, CRM, AI, `/providers`, adding port terminals and the FMCSA
re-check are platform-only. Refusals carry `problems`, the list of things to
fix (for example every reason a trip can't be dispatched).

| Route | Does |
|---|---|
| `GET /me`, `POST /onboarding` | Who am I (accepts a pending invitation on first sign-in); start a company or owner-operator business |
| `GET /members`, `POST /members/invitations`, `PATCH /members/:id` | Owners: team, invitations, roles, driver links, remove access |
| `GET /driver/trips`, `POST /driver/trips/:id/start\|complete\|events` | Driver app: trips with their legs, places and loads |
| `GET/POST /loads/:id/documents`, `POST /loads/:id/documents/upload-url` (also under `/driver`) | POD, BOL, photos via signed upload URLs |
| `POST /delivery-orders/upload-url`, `POST /delivery-orders/read`, `POST /delivery-orders` | Read a delivery order (file or pasted email) into a draft; create a load per container |
| `GET /legs?status=PLANNED`, `POST /legs/:id/advance`, `PATCH /legs/:id`, `POST /loads/:id/legs/plan` | The dispatch board, tapping a leg forward, terminal appointments, replanning |
| `POST /driver/legs/:id/advance` | The driver's next step on a leg |
| `POST /locations` | Your yard and empty depots |
| `GET /providers` | Which provider each capability uses and whether it is configured |
| `POST /email/send` | `{to, subject, html, replyTo?}` from the connected mailbox |
| `GET /email/unread?limit=20` | Unread inbox messages |
| `GET /crm/companies?q=` | Search companies |
| `POST /crm/companies` | `{name, domain?, type?, phone?}` |
| `POST /crm/contacts` | `{email, firstName?, lastName?, phone?, companyId?}` |
| `POST /llm/complete` | `{prompt, system?, maxTokens?}` |
| `GET/POST /loads`, `GET/PATCH /loads/:id` | Load board, filter by `status` and `equipment_type` |
| `POST /loads/:id/status` | `{status, note?}`, lifecycle-checked |
| `POST /loads/:id/empty-returned` | Stops per diem |
| `POST /loads/:id/invoice` | `{accessorials?, include_container_charges?}`; without `accessorials` the earned extras are billed |
| `GET /overview?days=7\|30` | Dashboard numbers |
| `GET/PUT /rate-card`, `GET /loads/:id/extras` | Prices for extras (owners change them) and what a load has earned |
| `GET/POST /drivers`, `/trucks`, `/trailers`; `PATCH …/:id` | Fleet (trailers include chassis) |
| `POST /dispatch` | `{leg_ids or load_ids, driver_id, truck_id, trailer_id?}` |
| `GET /trips`, `GET /trips/:id`, `POST /trips/:id/status`, `POST /trips/:id/events` | Dispatch, complete or cancel a trip; check calls |
| `GET /containers/alerts` | Demurrage, per diem and cutoff risk |
| `GET /street-turns?radius=50`, `POST /street-turns`, `POST /street-turns/:importId/approve\|reject` | Street turns |
| `POST /webhooks/port` | Terminal availability (HMAC-signed, see `.env.example`) |
| `GET/POST /customers`, `GET/PATCH /customers/:id`, `POST /customers/:id/locations`, `GET /locations`, `GET/POST /terminals` | Customers, locations, port terminals |
| `POST /customers/:id/fmcsa-check`, `POST /fmcsa/recheck`, `GET /fmcsa/carriers/:dot` | FMCSA |
| `GET/POST /tariffs`, `POST /quotes` | Rates |
| `GET /invoices` | Invoices |
| `GET /tracking` | Live GPS positions matched to trucks |

## Layout

- `packages/core`: the freight rules (equipment matching, load lifecycle, ISO 6346, demurrage and per diem, street turns), shared by the API and the web app.
- `packages/providers`: the email, CRM, AI, GPS, FMCSA and database adapters, plus the registry that picks one per capability.
- `apps/api`: the Express API (`apps/api/Dockerfile`; build from the repo root).
- `apps/web`: the Vite + React dispatcher app, deployed to Vercel.
- `supabase/migrations`: the schema. `002` turns on row-level security for every table (the API uses the service-role key); `003` adds equipment types, trailers, driver qualifications and container clocks; `004` adds organizations' members, invitations, `org_id` everywhere, load documents and the private `documents` storage bucket; `005` adds move types, `load_legs`, yards and depots, and delivery-order fields.

## Deploy

```bash
./scripts/init-supabase.sh  # link, push migrations, generate types
./scripts/init-vercel.sh    # web app on Vercel; set VITE_API_URL to the API's URL
```

The API runs anywhere Docker runs (for example Railway); keep every secret there, never in `VITE_` variables.
The web app can also run on Railway from `apps/web/Dockerfile` (Caddy serving the build); its `VITE_` variables are read at build time.

## Not built yet

- Scheduling the daily FMCSA re-check: point any scheduler (Railway cron, Supabase `pg_cron` + `pg_net`, n8n) at `POST /fmcsa/recheck`.
- An eModal or terminal connector that calls the port webhook.
- Documents (POD, rate confirmations), driver settlements, IFTA.
- Samsara and Motive GPS; Onyx Mail and Onyx CRM.
- Per-organization RLS policies, for when the web app reads Supabase directly
- MCP endpoints for agents
