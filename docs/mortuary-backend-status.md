# Onixus TMS–Mortuary — backend status

| | |
|---|---|
| Date | 2026-10-22 |
| Branch | `mortuary-backend-foundation` (PR open, **not merged**) |
| API contract | [`docs/mortuary-api-contract.md`](mortuary-api-contract.md) v1.1.0 (v1.0.0 committed first, before implementation) |
| Client | Thompson's Mortuary Services (domestic transport, international repatriation coordination) |
| Live? | **No.** Nothing is deployed, no migration has run on any Supabase project, no client data was moved, no email sent, no payment charged, no transport booked. |

## 1. What existed before this branch

Inspected `Onixus-AI/Onixus-TMS` at `1869d10` (2026-10-18) and `Onixus-AI/radiant-connect-dash` at `5d09d02` (2026-10-22). Neither repo has repo-level agent instructions for TMS; radiant-connect-dash's `CLAUDE.md` / `AGENTS.md` (verify against what a check actually covers; never present a proposal as live) were followed in spirit.

| Area | Found | Used here? |
|---|---|---|
| Auth and tenancy | Supabase Auth tokens, platform key + `X-Org-Id`, company keys (`onx_…`, Veltra); `scopedStore` stamps/filters `org_id` on every query; roles OWNER / DISPATCHER / DRIVER | **Reused unchanged.** Mortuary adds per-case restricted access on top. |
| Store | `Store` with compare-and-set updates (`update(..., expect)`), Supabase + in-memory implementations | **Reused**; added a cursor option (`ListOptions.after`) to both implementations. |
| Generic MORTUARY module | `transport_profiles.modules` includes `MORTUARY`; owner onboarding checklist (`mortuary_setup`, 6 checks); `service_jobs` intake with a custody *reference* at completion (migration 014) | **Reused** as the module gate and onboarding gate. The `service_jobs` flow is left untouched. |
| Fleet | `drivers`, `trucks`, `equipment` | **Reused** `drivers` and `trucks` as mortuary drivers and vehicles; freight trips' `ON_TRIP` status counts as a conflict. |
| Loads / legs / trips | Drayage-shaped: terminals, LOADED/EMPTY cargo, container rules, CDL/TWIC checks | **Not reused** — wrong shape for decedent transport. Mortuary legs are their own table. |
| Load documents | Private `documents` bucket, 1-hour signed URLs, **auto-copied to the company's Google Drive** | **Not reused.** Mortuary documents use a separate private bucket, 120-second links, never Drive. |
| Billing | Stripe checkout via `service_jobs`; `PAID` only from a signed webhook; `service_events` outbox pushed to Veltra Mail by the suite worker (includes job title, customer email, amount) | **Not wired.** Compatibility not confirmed (see §5). Mortuary invoices show payment `NOT_VERIFIED` and nothing can set it. |
| Integrations | Veltra suite worker (`SUITE_SYNC_ENABLED`), HubSpot CRM, Gmail/Outlook | **Not called.** A separate mortuary outbox records allow-listed events; no consumer exists. |
| radiant-connect-dash | Relay CRM (`relay_accounts` etc.), Signal (Thompson is client `9bbc0537-…`), Mail/comms functions; separate Supabase project `rjwbfkuzgusaoizcmmgf` | **Referenced only** by opaque ids (`crm_system: RELAY`, `crm_account_ref`). No shared database assumed. Nothing addressed to Signal. |
| Thompson's website | thompsonsms.com — services include hearse/transport, airline shipping, domestic and international transport; footer credits Onixus; assets suggest a Lovable build | **Repository not identified** in either repo. Not assumed, not touched. |

## 2. What this branch adds

| File | Purpose |
|---|---|
| `docs/mortuary-api-contract.md` | Frozen contract for Cursor (endpoints, auth, tenancy, fields, statuses, validation, pagination, errors, concurrency, examples) |
| `supabase/migrations/015_mortuary_cases.sql` | 14 additive tables, 3 trigger functions, private `mortuary-documents` bucket, RLS + service-role-only grants |
| `packages/core/src/mortuary-cases.ts` | Pure rules: case/leg state machines, custody corrections and custodian, transfer and identity rules, checklist, release readiness, pricing, integration allow-list |
| `apps/api/src/routes/mortuary.ts` | 46 endpoints: 42 under `/mortuary`, 4 under `/driver/mortuary` |
| `apps/api/src/app.ts`, `http.ts` | Mount routes with their own guards; `mortuaryFiles` on the context; errors gain optional `code` / `current` (additive) |
| `packages/providers/src/files.ts`, `db/store.ts` | Bucket parameter, URL lifetime, `exists()`; list cursor |
| Tests | `apps/api/src/mortuary.test.ts` (12), `packages/core/src/mortuary-cases.test.ts` (9), `supabase/tests/*` + `scripts/test-mortuary-sql.sh` |

No frontend component, navigation or style file was edited.

### Capabilities against the brief

| Brief item | Status in this release |
|---|---|
| 1. Tenant-scoped cases | Built. Case number, service type, requesting organization (+ CRM ref), authorized contacts, origin/destination, coordinator, status machine with guards, append-only status history. Decedent details in a separate restricted table with per-case access grants and an access audit log. |
| 2. Dispatch | Built. Ground / air / partner legs; driver + vehicle from the existing fleet; scheduled and actual timestamps; conflict detection in the API (overlaps, out-of-service, freight trips) and under lock in the database; dispatch board; driver app endpoints. |
| 3. Chain of custody | Built. Identity checks (tag compared server-side, observed value discarded), transfers with releasing/receiving parties and acknowledgments (typed, paper form, signature document, verbal), checkpoints, incidents and resolutions, attributable corrections. Append-only, contiguous, SHA-256 hash-linked. |
| 4. Documents | Built. Private bucket, case-scoped paths without names, upload → confirm → staff review, 120-second audited download links, missing-document checklist. |
| 5. Quotes and billing | Built for quotes and invoices with itemized service, mileage and additional charges. Quoted / invoiced / provider-verified payment are separate; **payment is never recorded** in this release. |
| 6. International | Built. Origin/destination/transit countries, receiving party, carrier, flight refs on air legs, shipment milestones (append-only), requirements with mandatory source + review date (90-day staleness), owner release approval with exact acknowledgment; always `legal_clearance: false`; never changes case status or books transport. |

## 3. Verification

All runs on 2026-10-22 in a clean clone of this branch.

| Check | Result | What it covers | What it does **not** cover |
|---|---|---|---|
| `npm run typecheck` | 4/4 packages clean | core, providers, api, web | — |
| `npm test` — core | 18/18 pass (9 existing + 9 new) | State machines, corrections, custodian, identity rule, tag check, checklist, staleness, pricing, integration allow-list, canonical JSON | — |
| `npm test` — api | 53/53 pass (41 existing + 12 new) | Through real HTTP against the Express app with an in-memory store that enforces the migration's unique constraints atomically: tenant isolation, role restrictions, restricted-data leakage across every case surface, private documents, invalid transitions, duplicate submissions, concurrent case transitions / custody appends / leg assignment / leg creation, international gating, billing states, pagination, module and onboarding gates, no case data in server logs | The Supabase/PostgREST adapter itself |
| Mutation check | Disabling the restricted-access check fails tests 2 and 4; disabling the `expected_seq` check fails test 8 | That the tests detect regressions in those protections | Other mutations were not tried |
| `npm run build` | Web build passes | Frontend unaffected | — |
| `scripts/test-mortuary-sql.sh` on local PostgreSQL 16.15 | All checks pass | Migration applies; tenant composite FKs; overlap guard (driver, vehicle, cross-org, back-to-back, canceled); custody contiguity and hash linkage; append-only on UPDATE / DELETE / TRUNCATE; Signal target rejected; one open invoice per quote; no payment column; required source + review date; RLS enabled, no anon/authenticated privileges; private bucket; **two real concurrent-session races** (overlapping assignment waits on the lock then fails; same-seq custody append cannot fork) | Real Supabase (Auth, PostgREST, Storage); earlier migrations 001–014 are stubbed because the sandbox has no PostGIS |
| Hash round trip on PostgreSQL 16.15 | Chain verifies after Postgres reformats timestamps (`…30.5-04:00`) and reorders JSONB keys; tampering detected | The API's normalisation for hashing | — |

## 4. Not verified / not live

- **No Supabase project was touched.** The migration has not been applied to staging or production; Storage signed upload/download and `exists()` are untested against Supabase Storage; the PostgREST paths (`.lt/.gt` cursor, jsonb round trip through supabase-js) are untested against a live project.
- **No frontend.** Cursor owns screens; nothing here renders.
- **Integration outbox has no consumer.** Events stay `PENDING`; CRM (Relay/HubSpot) and Mail (Veltra) receive nothing. Veltra Mail/CRM readiness was not assumed.
- **Payments:** no provider path for mortuary invoices.
- **Legal / regulatory:** requirements and checklists are staff-entered operational records. Nothing here establishes what any jurisdiction, consulate or carrier requires, and release approval is not legal clearance.
- Vehicle suitability (removal van vs. hearse, stretcher/cot capacity, refrigeration) is not modelled; any `trucks` row can be assigned.
- Driver location / ETA tracking for mortuary legs is not connected to GPS.
- Retention / deletion policy for restricted records and documents is not implemented; the access log has no read endpoint.
- Per-case lists other than cases and custody return at most 200 items.

## 5. Billing integration decision

The existing Stripe flow is attached to `service_jobs`: checkout amount comes from the job, the job's status machine requires a confirmed Google Calendar booking before completion, and every job status/payment change is written to `service_events`, which the Veltra suite worker pushes to Mail **with the job title, customer email and amount**. Using it for mortuary invoices would (a) force mortuary work through a calendar-booking state machine it does not fit and (b) risk case details leaving TMS through job titles. It was therefore **not** reused. A future mortuary payment path should be a signed provider webhook that writes a separate payment record linked to `mortuary_invoices`, never a client-settable field.

## 6. Setup (exact)

### Run the tests locally

```bash
git clone https://github.com/Onixus-AI/onixus-tms && cd onixus-tms
git checkout mortuary-backend-foundation
npm ci
npm run typecheck
npm test
```

### Run the database checks (disposable PostgreSQL 16 only)

```bash
createdb mortuary_scratch                     # any empty, throwaway database
MORTUARY_TEST_DATABASE_URL=postgres://postgres@localhost:5432/mortuary_scratch ./scripts/test-mortuary-sql.sh
dropdb mortuary_scratch
```

The script refuses Supabase hosts and non-empty databases.

### Before any deployment (not done; needs owner approval)

1. Review and merge the PR. Do not merge until Cursor's screens are ready to follow contract v1.1.0.
2. Apply `015_mortuary_cases.sql` to a **Supabase branch or staging project first** (`supabase link --project-ref <staging-ref>` then `supabase db push`). Confirm the `mortuary-documents` bucket exists and is private, and that RLS is on for all 14 `mortuary_*` tables (`get_advisors`).
3. Deploy the API to staging. No new environment variables are needed; it uses the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
4. For Thompson's organization (in staging, with fictional data): `PUT /transport/profile` with `MORTUARY` in `modules`, then the owner completes `PUT /transport/mortuary`. Rehearse a domestic and an international case end to end with fictional references, including a document upload/download through real Supabase Storage.
5. Only then plan production, with the owner present.

## 7. Suggested next steps

1. Staging rehearsal (§6) to close the Supabase-adapter gap.
2. Decide the outbox consumers: which Relay CRM function or Veltra endpoint receives `case.opened` / `case.status_changed` / `invoice.issued`, with what authentication.
3. Retention and access-log review endpoint for owners.
4. Vehicle suitability fields for removal vans and hearses.
