# Onixus Drayage OS

Trucking TMS. Drayage (containers) is the core; flatbed, dry van, box truck
and cargo van loads run through the same loads, dispatch and billing flow.
One authenticated API over swappable providers, the database schema, and the
dispatcher web app.

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
| AI model | `LLM_PROVIDER` | `claude` (default `claude-opus-5-5`), `openai`, `onyx` (OpenAI-compatible endpoint) |
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

Open http://localhost:5173 and enter the `TMS_API_KEY` under Connections.

```bash
npm test                    # API + provider tests
npm run typecheck
npm run build               # web app → apps/web/dist
```

## API

Every route except `/health` and the signed port webhook requires
`Authorization: Bearer $TMS_API_KEY`. Refusals carry `problems`, the list of
things to fix (for example every reason a trip can't be dispatched).

| Route | Does |
|---|---|
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
| `POST /loads/:id/invoice` | `{accessorials?, include_container_charges?}` |
| `GET/POST /drivers`, `/trucks`, `/trailers`; `PATCH …/:id` | Fleet (trailers include chassis) |
| `POST /dispatch` | `{load_ids, driver_id, truck_id, trailer_id?}` |
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
- `supabase/migrations`: the schema. `002` turns on row-level security for every table (the API uses the service-role key); `003` adds equipment types, trailers, driver qualifications and container clocks.

## Deploy

```bash
./scripts/init-supabase.sh  # link, push migrations, generate types
./scripts/init-vercel.sh    # web app; set VITE_API_URL to the API's URL
```

The API runs anywhere Docker runs (for example Railway); keep every secret there, never in `VITE_` variables.

## Not built yet

- Scheduling the daily FMCSA re-check: point any scheduler (Railway cron, Supabase `pg_cron` + `pg_net`, n8n) at `POST /fmcsa/recheck`.
- An eModal or terminal connector that calls the port webhook.
- Documents (POD, rate confirmations), driver settlements, IFTA.
- Samsara and Motive GPS; Onyx Mail and Onyx CRM.
- Per-organization RLS policies, for when the web app reads Supabase directly
- MCP endpoints for agents
