# Onixus TMS–Mortuary API contract

| | |
|---|---|
| Contract version | **1.1.0 — FROZEN 2026-10-22** (1.0.0 frozen before implementation; 1.1.0 adds only clarifications and additive fields, see [Change log](#change-log)) |
| Owner (backend) | Onixus TMS API (`apps/api/src/routes/mortuary.ts`) |
| Consumer (frontend) | Cursor-owned web components |
| Change policy | Any change after freeze gets a new version, a row in [Change log](#change-log), and is called out in the PR description. Additive fields are minor versions; anything that removes, renames or re-types a field, status or rule is a major version. |

All example data in this document is fictional. Email domains use `.test`; phone numbers use the reserved `555-01xx` range.

---

## 1. Scope and boundaries

TMS–Mortuary is the **operational case and custody system** for mortuary transport and international repatriation coordination. It extends the existing Onixus TMS; drayage loads, legs, trips, invoices and the generic `/operations` service jobs are unchanged.

| System | Owns | How TMS–Mortuary refers to it |
|---|---|---|
| TMS–Mortuary (this API) | Cases, restricted decedent records, dispatch legs, chain of custody, case documents, quotes/invoices, international coordination | — |
| CRM (Relay CRM, HubSpot, …) | Business relationships: funeral homes, agents, accounts | `crm_system` + `crm_account_ref` / `crm_contact_ref` strings on a case. TMS never reads or writes the CRM in this release. |
| Mail (Veltra Mail, Gmail, …) | Correspondence | `mail_thread_refs` strings on a case. TMS sends no email for mortuary cases. |
| Signal | Approved marketing | **Nothing.** No mortuary data is addressed to Signal. The integration outbox rejects a `SIGNAL` target at the database. |
| Authentication | Supabase Auth (existing) | Same bearer tokens and roles as the rest of TMS. |
| Payments | Stripe via the existing provider (not wired for mortuary) | Invoice `payment` is a read-only view. No endpoint in this contract records payment. |

What this API **does not** do: grant legal clearance, approve transport automatically, book carriers or flights, send email, charge payments, or claim that a jurisdiction's requirements are complete. Release approval is a recorded human decision.

---

## 2. Conventions

### 2.1 Base URL and transport

- Same API host as the rest of TMS (`VITE_API_URL`). JSON only: `Content-Type: application/json`.
- Office routes are under `/mortuary`. Driver routes are under `/driver/mortuary`.
- Timestamps are ISO 8601 UTC strings with `Z` (`2026-10-22T14:05:00.000Z`). Dates are `YYYY-MM-DD`.
- IDs are UUID v4 strings. Money is integer **cents**, USD only in this release (`currency: "USD"`).
- Country codes are ISO 3166-1 alpha-2, upper case (`US`, `JM`, `NG`).
- Responses that contain restricted data or signed URLs carry `Cache-Control: no-store`.

### 2.2 Authentication and tenant context

Every route needs `Authorization: Bearer <token>`.

| Caller | How tenant is chosen | Mortuary access |
|---|---|---|
| Signed-in person (Supabase access token) | Their membership's organization | By role, below |
| Platform key (`TMS_API_KEY`) + `X-Org-Id: <org uuid>` | The header | Non-restricted office routes only. Never restricted records, document URLs, document review, release approval or access grants. |
| Company key (`onx_…`, e.g. Veltra) | The key's organization | **None.** All `/mortuary` and `/driver/mortuary` routes answer `403 FORBIDDEN`. |

The organization is never taken from the request body. A record belonging to another organization reads as `404 NOT_FOUND`, never `403`, so IDs from other tenants are not confirmable.

The organization must have the `MORTUARY` transport module enabled (`PUT /transport/profile`, existing) or every mortuary write answers `409 MODULE_DISABLED`. Dispatch assignment, the `READY_FOR_DISPATCH` transition and international release approval also require the existing owner onboarding checklist to be complete (`PUT /transport/mortuary`), else `409 ONBOARDING_INCOMPLETE`.

### 2.3 Roles and permissions

Roles are the existing TMS roles. "Restricted access" means: the caller is a signed-in person **and** (role is `OWNER`, **or** they are the case's `coordinator_member_id`, **or** an owner granted them access to that case and it is not revoked).

| Capability | OWNER | DISPATCHER | DRIVER (own legs) | Platform key |
|---|---|---|---|---|
| Create / list / read / edit cases, transitions | ✓ | ✓ | — | ✓ |
| Read / write restricted decedent record | ✓ | if restricted access | — | — |
| Grant / revoke case access | ✓ | — | — | — |
| Create / edit legs, assign, leg status | ✓ | ✓ | leg status on own legs | ✓ |
| Record custody events (not corrections) | ✓ | ✓ | on own legs | ✓ |
| Record custody **corrections** | ✓ | ✓ | — | — |
| List document metadata and checklist | ✓ | ✓ | — | ✓ |
| Create upload / mark uploaded | ✓ | ✓ | — | — |
| Download URL, document review | ✓ | if restricted access | — | — |
| Draft quotes | ✓ | ✓ | — | ✓ |
| Issue / accept quotes, issue / void invoices | ✓ | — | — | — |
| International record, requirements, milestones | ✓ | ✓ | — | ✓ |
| International release approval / revoke | ✓ | — | — | — |

Drivers use only `/driver/mortuary/*`. A driver calling `/mortuary/*` receives `403 FORBIDDEN` ("Drivers use the driver app").

### 2.4 Errors

Every error body:

```json
{ "error": "Human readable message", "code": "VERSION_CONFLICT", "problems": ["optional list of things to fix"], "current": { "optional": "state" } }
```

`problems` and `current` appear only where listed. Validation errors keep the existing TMS shape and add `code`:

```json
{ "error": "Invalid request", "code": "VALIDATION_FAILED", "issues": [ { "path": ["origin","country"], "message": "Use a two-letter ISO country code" } ] }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body, query or path failed validation. Unknown body fields are rejected (strict objects). |
| 400 | `BAD_REQUEST` | Semantically invalid input that passed shape checks (e.g. end before start). |
| 401 | — | Missing / invalid token (existing behaviour, no `code`). |
| 403 | `FORBIDDEN` | Role or caller type not allowed. |
| 403 | `RESTRICTED_ACCESS_REQUIRED` | Needs restricted access to this case. |
| 404 | `NOT_FOUND` | Not found **in the caller's organization**. |
| 409 | `MODULE_DISABLED` | Mortuary module not enabled. |
| 409 | `ONBOARDING_INCOMPLETE` | Owner onboarding checklist incomplete. `problems` lists gaps. |
| 409 | `VERSION_CONFLICT` | `expected_version` is stale. `current` = `{ "version": n, "status": "…" }`. |
| 409 | `SEQUENCE_CONFLICT` | `expected_seq` is stale. `current` = `{ "last_seq": n }`. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same `request_key` sent with a different body. |
| 409 | `INVALID_TRANSITION` | Status change not allowed. `problems` lists unmet conditions. |
| 409 | `ASSIGNMENT_CONFLICT` | Driver or vehicle double-booked or unavailable. `problems` lists conflicts. |
| 409 | `NOT_READY` | Release approval blocked. `problems` lists what is missing. |
| 409 | `UPLOAD_NOT_FOUND` | File not present in storage when marking uploaded. |
| 409 | `CONFLICT` | Other state conflict (message explains). |
| 502 / 503 | `STORAGE_UNAVAILABLE` | Storage provider failed or is not configured. |

### 2.5 Concurrency and idempotency

These rules are part of the contract; the frontend must follow them.

1. **Creation is idempotent by `request_key`.** Every `POST` that creates a record takes a client-generated `request_key` (UUID v4). Generate it once per user intent (when the form opens) and reuse it for retries.
   - Same key, same body → `200` with the original record (`"replayed": true`). First success is `201`.
   - Same key, different body → `409 IDEMPOTENCY_KEY_REUSED`.
   - Keys are unique per organization per record type and never expire.
2. **Mutable records use optimistic versions.** Cases, restricted records, legs, documents, quotes, invoices, international records and requirements carry an integer `version` starting at `1`. Every mutating call sends `expected_version`; the server applies the change only if the stored version still matches and returns the new record with `version + 1`. Otherwise `409 VERSION_CONFLICT` with `current`. Reload and let the person re-decide; never auto-retry a different change.
3. **Case transitions are idempotent by `request_key` too.** `POST /transitions` takes both `expected_version` and `request_key`. A replay of an already-applied transition (same key) returns `200` with the current case and `"replayed": true`, even though the version has moved. If a transition applied but its history row was not written (a crash between the two writes), the replay answers `409 VERSION_CONFLICT`; the frontend reloads and sees the status already changed.
4. **Append-only logs use sequence numbers.** Custody events are numbered per case (`seq` = 1, 2, 3…). A new event sends `expected_seq` = the highest `seq` the client has seen (`0` for none). The server stores it at `expected_seq + 1`; a database unique constraint means two clients racing for the same position get one success and one `409 SEQUENCE_CONFLICT`. Combined with `request_key`, a retried submission never creates a duplicate.
5. **Concurrent dispatch is guarded in the database.** Assigning a driver/vehicle locks that driver and vehicle inside the transaction and re-checks overlapping windows, so two dispatchers cannot double-book even if both passed the API pre-check. The loser receives `409 ASSIGNMENT_CONFLICT`.
6. **Nothing in an append-only log is updated or deleted.** Custody events, case status history, shipment milestones and the access audit log reject `UPDATE`/`DELETE` at the database. Corrections are new, attributed events (§7.3, §10.4).

### 2.6 Pagination

Only lists that can grow without bound are paginated:

- `GET /mortuary/cases` — cursor pagination. Query `limit` (1–100, default 25) and `cursor` (opaque string from the previous response). Response: `{ "cases": [...], "next_cursor": "…" | null }`. Order: newest first. Cursors are stable under inserts.
- `GET /mortuary/cases/:id/custody-events` — `after_seq` (default 0) and `limit` (1–200, default 200). Response includes `next_after_seq` or `null`.

Other per-case lists (legs, documents, quotes, invoices, requirements, milestones, history, integration events) return up to 200 items, oldest first, with no cursor. A case that exceeds 200 of any of these is outside this release.

### 2.7 Shared field types

`Place`:

| Field | Type | Rules |
|---|---|---|
| `name` | string | 1–200, required |
| `facility_type` | enum | `HOSPITAL`, `HOSPICE`, `RESIDENCE`, `MEDICAL_EXAMINER`, `FUNERAL_HOME`, `AIRPORT_CARGO`, `CEMETERY`, `CREMATORY`, `OTHER` |
| `address_line` | string? | ≤ 300 |
| `city` | string? | ≤ 120 |
| `region` | string? | ≤ 120 (state / province) |
| `postal_code` | string? | ≤ 20 |
| `country` | string | ISO alpha-2, required |

`Party` (custody):

| Field | Type | Rules |
|---|---|---|
| `kind` | enum | `RELEASING_FACILITY`, `TRANSPORT_STAFF`, `FUNERAL_HOME`, `AIRLINE_CARGO`, `RECEIVING_AGENT`, `FAMILY_REPRESENTATIVE`, `MEDICAL_EXAMINER`, `OTHER` |
| `name` | string | 1–200, person's name |
| `organization` | string? | ≤ 200 |
| `title` | string? | ≤ 120 |
| `driver_id` | uuid? | Required when `kind` = `TRANSPORT_STAFF` and the person is one of this company's drivers; must exist in the organization |

`Acknowledgment`:

| Field | Type | Rules |
|---|---|---|
| `method` | enum | `SIGNATURE_DOCUMENT`, `TYPED_NAME`, `PAPER_FORM`, `VERBAL_CONFIRMED_BY_STAFF` |
| `document_id` | uuid? | Required for `SIGNATURE_DOCUMENT`; a `CUSTODY_ACKNOWLEDGMENT` document on the same case |
| `typed_name` | string? | Required for `TYPED_NAME`; 1–200 |
| `reference` | string? | Required for `PAPER_FORM` (form number); ≤ 200 |
| `acknowledged_at` | timestamp | Required; not more than 5 minutes in the future |

`ChargeLine`:

| Field | Type | Rules |
|---|---|---|
| `category` | enum | `SERVICE`, `MILEAGE`, `ADDITIONAL` |
| `code` | string? | ≤ 40, the business's own code |
| `description` | string | 1–200 |
| `quantity` | number | > 0, ≤ 100000; for `MILEAGE` this is miles (up to 1 decimal) |
| `unit_cents` | integer | 1 – 99,999,999 |
| `amount_cents` | integer | **Server-computed**: `round(quantity × unit_cents)`. Ignored on input. |

Totals: `subtotal_cents` = Σ `amount_cents`, must be ≤ 99,999,999.

---

## 3. Statuses

### 3.1 Case `status`

| Status | Meaning |
|---|---|
| `INTAKE` | Request received; details being gathered |
| `AWAITING_RELEASE` | Waiting for release authorization / documents |
| `READY_FOR_DISPATCH` | Required documents approved (and, for international, staff release approval recorded) |
| `IN_TRANSIT` | Company transport staff hold custody |
| `ON_HOLD` | Paused; `held_from_status` remembers where it was |
| `DELIVERED` | Released to the final receiving party |
| `CLOSED` | Administratively closed |
| `CANCELED` | Canceled before company custody |

Allowed transitions and guards (`problems` lists every unmet guard):

| From | To | Guards |
|---|---|---|
| `INTAKE` | `AWAITING_RELEASE` | — |
| `INTAKE`, `AWAITING_RELEASE` | `CANCELED` | Company transport staff do not hold custody |
| `AWAITING_RELEASE` | `READY_FOR_DISPATCH` | Onboarding complete; every required document category has an `APPROVED` document; international cases: release approval `APPROVED` |
| `READY_FOR_DISPATCH` | `AWAITING_RELEASE` | — (e.g. a document was found invalid) |
| `READY_FOR_DISPATCH` | `IN_TRANSIT` | Current custodian (from the custody log) is `TRANSPORT_STAFF` |
| `READY_FOR_DISPATCH` | `CANCELED` | Company transport staff do not hold custody |
| `IN_TRANSIT` | `DELIVERED` | Current custodian is not `TRANSPORT_STAFF`; every non-canceled leg is `DELIVERED` |
| `DELIVERED` | `CLOSED` | No unresolved custody incident |
| any of `INTAKE`, `AWAITING_RELEASE`, `READY_FOR_DISPATCH`, `IN_TRANSIT` | `ON_HOLD` | `reason` required |
| `ON_HOLD` | the value of `held_from_status` | The guards for that status, re-checked |
| `ON_HOLD` | `CANCELED` | Company transport staff do not hold custody |

`CLOSED` and `CANCELED` are terminal. `reason` is required for `ON_HOLD`, `CANCELED` and any backward move (`READY_FOR_DISPATCH` → `AWAITING_RELEASE`).

### 3.2 Leg `status`

`PLANNED` → `ASSIGNED` → `EN_ROUTE` → `IN_CUSTODY` → `DELIVERED`; `CANCELED` from `PLANNED`, `ASSIGNED`, `EN_ROUTE`.

| To | Guards | Timestamp set |
|---|---|---|
| `ASSIGNED` | Via the assignment endpoint only | `assigned_at` |
| `EN_ROUTE` | Leg is `ASSIGNED`; case is `READY_FOR_DISPATCH` or `IN_TRANSIT` | `actual_departure_at` |
| `IN_CUSTODY` | A custody `TRANSFER` on this leg whose receiving party is `TRANSPORT_STAFF` (or `AIRLINE_CARGO` for `AIR` legs, `RECEIVING_AGENT`/`FUNERAL_HOME` for `PARTNER` legs) | `actual_pickup_at` |
| `DELIVERED` | A later custody `TRANSFER` on this leg whose releasing party is the leg's custodian | `actual_delivery_at` |
| `CANCELED` | `reason`; leg is not `IN_CUSTODY` | `canceled_at` |

Actual timestamps default to the server time; a caller may send `occurred_at` up to 24 hours in the past (never in the future).

### 3.3 Document `status`

`UPLOAD_PENDING` → `RECEIVED` → `APPROVED` | `REJECTED`. An `APPROVED` or `REJECTED` document can be reviewed again only by uploading a new document; review decisions are not overwritten.

### 3.4 Billing states — kept distinct

| Record | Field | Values | Written by |
|---|---|---|---|
| Quote | `status` | `DRAFT`, `ISSUED`, `ACCEPTED`, `SUPERSEDED`, `DECLINED` | Owner actions |
| Invoice | `status` | `ISSUED`, `VOID` | Owner actions |
| Invoice | `payment.status` | `NOT_VERIFIED` (only value in this release); reserved: `PROVIDER_VERIFIED_PAID`, `PROVIDER_VERIFIED_PARTIAL`, `REFUNDED`, `REVIEW` | **Only** a signed payment-provider webhook (not implemented). No endpoint accepts it. |

A quote being accepted does not mean an invoice exists; an invoice existing does not mean payment occurred.

### 3.5 International `release_status`

`NOT_REQUESTED` → `APPROVED` → `REVOKED` (→ `APPROVED` again). Approval is a staff record, not legal clearance; the response always includes `"legal_clearance": false`.

### 3.6 Requirement `status`

`OPEN`, `SATISFIED`, `NOT_APPLICABLE`. A requirement is **stale** when `reviewed_on` is more than **90 days** before today; stale requirements block release approval until re-reviewed.

---

## 4. Cases

### 4.1 `Case` object

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `case_number` | string | Unique per organization. Client may supply (`^[A-Za-z0-9-]{3,40}$`); otherwise server generates `MC-YYMMDD-XXXX`. |
| `service_type` | enum | `FIRST_CALL_REMOVAL`, `DOMESTIC_TRANSFER`, `AIRPORT_TRANSFER`, `INTERNATIONAL_INBOUND`, `INTERNATIONAL_OUTBOUND` |
| `international` | boolean | Derived: true for `INTERNATIONAL_*` |
| `requesting_organization` | object | `{ name (1–200), type: FUNERAL_HOME|HOSPITAL|HOSPICE|MEDICAL_EXAMINER|FAMILY|AGENT|OTHER, phone?, email? }` |
| `crm_system` | enum? | `RELAY`, `HUBSPOT`, `OTHER` |
| `crm_account_ref` | string? | ≤ 200, opaque CRM id |
| `authorized_contacts` | array | 0–10 of `{ name (1–200), relationship: NEXT_OF_KIN|LEGAL_REPRESENTATIVE|FUNERAL_DIRECTOR|FACILITY_STAFF|AGENT|OTHER, phone?, email?, may_authorize_release: boolean, crm_contact_ref? }` |
| `origin` | Place | |
| `destination` | Place | |
| `coordinator_member_id` | uuid? | Membership id of an `OWNER` or `DISPATCHER` in the organization |
| `required_document_categories` | string[] | Extra categories staff added to this case's checklist |
| `mail_thread_refs` | string[] | 0–20 opaque strings, ≤ 200 each |
| `status` | enum | §3.1 |
| `held_from_status` | enum? | Set while `ON_HOLD` |
| `version` | integer | |
| `has_restricted_record` | boolean | Whether a restricted record exists (no content) |
| `restricted_access` | boolean | Whether **this caller** has restricted access |
| `created_by`, `created_at`, `updated_at` | | |

No decedent name, date of birth, date of death or handling notes ever appear on a `Case`, in lists, in history, in integration events, or in errors.

### 4.2 `POST /mortuary/cases` → 201 `{ case }`

Roles: OWNER, DISPATCHER, platform key.

```json
{
  "request_key": "9f1c3d1e-4a52-4f7b-9d61-0c1f8a3e2b10",
  "case_number": "EX-2026-0042",
  "service_type": "INTERNATIONAL_OUTBOUND",
  "requesting_organization": { "name": "Example Family Funeral Home", "type": "FUNERAL_HOME", "phone": "+1 404 555 0100", "email": "intake@example-fh.test" },
  "crm_system": "RELAY",
  "crm_account_ref": "relay-acct-fixture-001",
  "authorized_contacts": [
    { "name": "Alex Sample", "relationship": "FUNERAL_DIRECTOR", "phone": "+1 404 555 0101", "email": "alex@example-fh.test", "may_authorize_release": true }
  ],
  "origin": { "name": "Example General Hospital", "facility_type": "HOSPITAL", "city": "Atlanta", "region": "GA", "country": "US" },
  "destination": { "name": "Example Receiving Funeral Services", "facility_type": "FUNERAL_HOME", "city": "Kingston", "country": "JM" },
  "coordinator_member_id": "5b0f7c2a-1d34-4e8b-a0c1-2f9e8d7c6b5a",
  "mail_thread_refs": ["veltra-thread-fixture-17"]
}
```

`case_number`, `crm_*`, `authorized_contacts`, `coordinator_member_id`, `required_document_categories`, `mail_thread_refs` are optional. A duplicate `case_number` → `409 CONFLICT`. Created in `INTAKE`, version 1.

Side effect: an integration event `case.opened` is queued for `CRM` if `crm_account_ref` is set, and for `MAIL` if `mail_thread_refs` is non-empty (§11).

### 4.3 `GET /mortuary/cases` → 200 `{ cases, next_cursor }`

Query: `status`, `service_type`, `coordinator_member_id`, `limit`, `cursor`. Filters are exact matches; `status` may repeat (`?status=INTAKE&status=AWAITING_RELEASE`).

### 4.4 `GET /mortuary/cases/:id` → 200

```json
{
  "case": { "id": "…", "case_number": "EX-2026-0042", "status": "AWAITING_RELEASE", "version": 3, "…": "…" },
  "summary": {
    "current_custodian": null,
    "open_incidents": 0,
    "legs": { "total": 2, "delivered": 0, "canceled": 0 },
    "checklist": { "required": 6, "approved": 2, "missing": ["TRANSIT_PERMIT", "AIRWAY_BILL"], "awaiting_review": ["DEATH_CERTIFICATE", "CONSULAR_DOCUMENT"] },
    "international": { "release_status": "NOT_REQUESTED", "stale_requirements": 0, "open_requirements": 3 }
  }
}
```

`current_custodian` is the effective receiving `Party` of the latest `TRANSFER` (after corrections) or `null`. `international` is `null` for domestic cases.

### 4.5 `PATCH /mortuary/cases/:id` → 200 `{ case }`

Body: `expected_version` plus any of `requesting_organization`, `crm_system`, `crm_account_ref`, `authorized_contacts`, `origin`, `destination`, `coordinator_member_id`, `required_document_categories`, `mail_thread_refs`; and `service_type` while `INTAKE` only. Arrays and objects are replaced whole. Not allowed in `DELIVERED`, `CLOSED`, `CANCELED` (`409 CONFLICT`). `null` clears an optional field.

### 4.6 `POST /mortuary/cases/:id/transitions` → 200 `{ case, replayed }`

```json
{ "request_key": "2d7e8f90-1a2b-4c3d-8e9f-a0b1c2d3e4f5", "to": "ON_HOLD", "expected_version": 3, "reason": "Awaiting consulate appointment" }
```

`reason` ≤ 500. Errors: `INVALID_TRANSITION` (with `problems`), `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED` (same key, different `to`). Side effect: a history row and a `case.status_changed` integration event (when references exist).

### 4.7 `GET /mortuary/cases/:id/history` → 200 `{ history }`

`history[]`: `{ id, from_status, to_status, reason, actor: { kind: "USER"|"PLATFORM", user_id?, member_id?, role? }, created_at }`, oldest first.

---

## 5. Restricted case record

Requires restricted access (§2.3). Every read and write is recorded in the access audit log (who, which case, which action — never the content).

### 5.1 `GET /mortuary/cases/:id/restricted` → 200 `{ record }` (`Cache-Control: no-store`)

`404 NOT_FOUND` if the case exists but no record has been written yet (the case's `has_restricted_record` tells you which).

`record`:

| Field | Type | Rules |
|---|---|---|
| `case_id` | uuid | |
| `decedent_full_name` | string | 1–200 |
| `date_of_birth` | date? | |
| `date_of_death` | date? | Not before `date_of_birth`; not in the future |
| `place_of_death` | string? | ≤ 300 |
| `id_tag_number` | string? | ≤ 80. Used server-side to check identification; drivers never receive it |
| `handling_notes` | string? | ≤ 2000 |
| `precautions` | string? | ≤ 1000 |
| `personal_effects` | string? | ≤ 2000 |
| `religious_or_cultural_considerations` | string? | ≤ 1000 |
| `version` | integer | |
| `updated_by`, `updated_at` | | |

### 5.2 `PUT /mortuary/cases/:id/restricted` → 200 `{ record }`

Body: the fields above plus `expected_version` (`0` to create). Full replacement: omitted optional fields are cleared.

### 5.3 Case access grants (OWNER only)

- `GET /mortuary/cases/:id/access` → `{ grants: [{ member_id, email, role, granted_by, granted_at, revoked_at }] }`
- `POST /mortuary/cases/:id/access` `{ "member_id": "…" }` → 201 `{ grant }`. Member must be an active `OWNER` or `DISPATCHER` of the organization. Idempotent: granting an active grant returns it with `200`.
- `POST /mortuary/cases/:id/access/:memberId/revoke` → 200 `{ grant }`.

---

## 6. Dispatch

### 6.1 `Leg` object

| Field | Type | Notes |
|---|---|---|
| `id`, `case_id` | uuid | |
| `seq` | integer | Order within the case, server-assigned (1, 2, …) |
| `mode` | enum | `GROUND` (company driver + vehicle), `AIR` (airline cargo), `PARTNER` (another provider) |
| `from`, `to` | Place | |
| `scheduled_departure_at` | timestamp | Required |
| `scheduled_arrival_at` | timestamp | Required, after departure, window ≤ 72 h |
| `driver_id`, `vehicle_id` | uuid? | `GROUND` only. `vehicle_id` is a row in the existing TMS `trucks` fleet |
| `carrier` | object? | `AIR`/`PARTNER`: `{ name (1–200), flight_number? (^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$), airway_bill? (≤ 40), partner_reference? (≤ 200) }` |
| `status` | enum | §3.2 |
| `assigned_at`, `actual_departure_at`, `actual_pickup_at`, `actual_delivery_at`, `canceled_at` | timestamp? | Set by transitions |
| `cancel_reason` | string? | |
| `version` | integer | |

### 6.2 Endpoints

- `GET /mortuary/cases/:id/legs` → `{ legs }`
- `POST /mortuary/cases/:id/legs` → 201 `{ leg }` — `{ request_key, mode, from, to, scheduled_departure_at, scheduled_arrival_at, carrier? }`. Not allowed when the case is `DELIVERED`, `CLOSED` or `CANCELED`.
- `PATCH /mortuary/cases/:id/legs/:legId` → `{ leg }` — `{ expected_version, from?, to?, scheduled_departure_at?, scheduled_arrival_at?, carrier? }`; only while `PLANNED` or `ASSIGNED`. Rescheduling an `ASSIGNED` `GROUND` leg re-runs conflict checks.
- `POST /mortuary/cases/:id/legs/:legId/assignment` → `{ leg }` or, with `dry_run`, `{ ok: true, problems: [] }`

  ```json
  { "expected_version": 1, "driver_id": "…", "vehicle_id": "…", "dry_run": false }
  ```
  For `AIR`/`PARTNER` legs send `carrier` instead of driver/vehicle. Leg must be `PLANNED` (or `ASSIGNED` to re-assign). Requires onboarding complete.

  `ASSIGNMENT_CONFLICT` problems (all that apply):
  - driver or vehicle not found / status `OUT_OF_SERVICE` / `OFF_DUTY`;
  - driver or vehicle currently `ON_TRIP` on a freight trip;
  - driver already on another active mortuary leg (`ASSIGNED`, `EN_ROUTE`, `IN_CUSTODY`) whose scheduled window overlaps;
  - same for the vehicle.

  `dry_run: true` returns `200 { ok, problems }` and changes nothing.
- `POST /mortuary/cases/:id/legs/:legId/unassign` → `{ leg }` — `{ expected_version }`; only from `ASSIGNED`.
- `POST /mortuary/cases/:id/legs/:legId/status` → `{ leg }` — `{ to, expected_version, occurred_at?, reason? }`.
- `GET /mortuary/dispatch/board?from=…&to=…` → `{ legs: [ Leg & { case_number, service_type } ] }` — active legs (`PLANNED`, `ASSIGNED`, `EN_ROUTE`, `IN_CUSTODY`) whose window intersects `[from, to]`; window ≤ 14 days; ≤ 500 items.

### 6.3 Driver endpoints

Caller must be a signed-in person linked to a driver record (existing rule). Only legs with `driver_id` = the caller's driver.

- `GET /driver/mortuary/legs` → `{ legs: [DriverLeg] }`, legs `ASSIGNED`, `EN_ROUTE`, `IN_CUSTODY`.
  `DriverLeg` = `{ id, case_id, case_number, seq, mode, from, to, scheduled_departure_at, scheduled_arrival_at, status, version, vehicle_id }`. No contacts, no decedent data, no tag number.
- `POST /driver/mortuary/legs/:legId/status` — same body as §6.2 status; `to` ∈ `EN_ROUTE`, `IN_CUSTODY`, `DELIVERED`.
- `GET /driver/mortuary/legs/:legId/custody-events` → events on this leg only.
- `POST /driver/mortuary/legs/:legId/custody-events` — same body as §7.2, `leg_id` implied; kinds `IDENTITY_CHECK`, `TRANSFER`, `CHECKPOINT`, `INCIDENT`. Leg must be `ASSIGNED`, `EN_ROUTE` or `IN_CUSTODY`.

---

## 7. Chain of custody

### 7.1 `CustodyEvent` object

| Field | Type | Notes |
|---|---|---|
| `id`, `case_id` | uuid | |
| `seq` | integer | 1-based, contiguous per case |
| `kind` | enum | `IDENTITY_CHECK`, `TRANSFER`, `CHECKPOINT`, `INCIDENT`, `INCIDENT_RESOLVED`, `CORRECTION` |
| `leg_id` | uuid? | |
| `occurred_at` | timestamp | When it happened (≤ 5 min in the future, ≤ 30 days in the past) |
| `recorded_at` | timestamp | Server time |
| `recorded_by` | object | `{ kind: "USER"|"PLATFORM", user_id?, member_id?, role? }` |
| `payload` | object | By kind, below |
| `prev_hash`, `hash` | string | SHA-256 hex chain (tamper evidence) |

Payloads:

| `kind` | `payload` |
|---|---|
| `IDENTITY_CHECK` | `{ method: TAG|WRISTBAND|PAPERWORK|FACILITY_STAFF_CONFIRMATION, outcome: VERIFIED|DISCREPANCY|UNABLE, tag_check: MATCH|MISMATCH|NOT_ON_FILE|NOT_PROVIDED, note? }`. Input may include `observed_tag` (≤ 80): the server compares it to the restricted `id_tag_number` and stores **only** `tag_check`, never the observed value. `MISMATCH` forces `outcome: DISCREPANCY`. |
| `TRANSFER` | `{ releasing_party: Party, receiving_party: Party, location: Place, releasing_acknowledgment: Acknowledgment, receiving_acknowledgment: Acknowledgment, note? }` |
| `CHECKPOINT` | `{ type: ARRIVED|DEPARTED|LOADED|UNLOADED|STORAGE_IN|STORAGE_OUT|OTHER, location?: Place, note? }` |
| `INCIDENT` | `{ incident_key (server uuid), severity: LOW|MEDIUM|HIGH, category: DELAY|ID_DISCREPANCY|DOCUMENT_ISSUE|VEHICLE|DAMAGE|HANDLING|OTHER, description (1–2000) }` |
| `INCIDENT_RESOLVED` | `{ incident_key, resolution (1–2000) }` |
| `CORRECTION` | `{ corrects_seq, reason (1–1000), changes: { occurred_at?, payload?: partial payload of the corrected kind } }` |

Rules:

- A `TRANSFER` requires, since the previous `TRANSFER` (or since the case began), an `IDENTITY_CHECK` whose effective `outcome` is `VERIFIED`. Otherwise `409 INVALID_TRANSITION`.
- A `TRANSFER`'s `releasing_party.kind` must equal the current custodian's `kind` (when there is a custodian).
- `INCIDENT_RESOLVED` must reference an unresolved `incident_key` on the case.
- `CORRECTION` cannot target another `CORRECTION`, cannot change `kind`, `seq`, `leg_id` or `incident_key`, and is not available to drivers. The original event stays unchanged.
- Signatures: upload the signed form or signature image as a `CUSTODY_ACKNOWLEDGMENT` document first (§8), then reference its `document_id`.

### 7.2 `POST /mortuary/cases/:id/custody-events` → 201 `{ event, current_custodian }`

```json
{
  "request_key": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "expected_seq": 1,
  "kind": "TRANSFER",
  "leg_id": "…",
  "occurred_at": "2026-10-22T15:10:00.000Z",
  "payload": {
    "releasing_party": { "kind": "RELEASING_FACILITY", "name": "Casey Fixture", "organization": "Example General Hospital", "title": "Morgue attendant" },
    "receiving_party": { "kind": "TRANSPORT_STAFF", "name": "Riley Driver", "driver_id": "…" },
    "location": { "name": "Example General Hospital", "facility_type": "HOSPITAL", "city": "Atlanta", "region": "GA", "country": "US" },
    "releasing_acknowledgment": { "method": "PAPER_FORM", "reference": "REL-FORM-0001", "acknowledged_at": "2026-10-22T15:09:00.000Z" },
    "receiving_acknowledgment": { "method": "TYPED_NAME", "typed_name": "Riley Driver", "acknowledged_at": "2026-10-22T15:09:30.000Z" }
  }
}
```

Replay of the same `request_key` → `200` with the original event and `"replayed": true`.

### 7.3 `GET /mortuary/cases/:id/custody-events` → 200

```json
{
  "events": [ { "seq": 1, "kind": "IDENTITY_CHECK", "…": "…" } ],
  "effective": [ { "seq": 1, "kind": "IDENTITY_CHECK", "occurred_at": "…", "payload": { "…": "…" }, "corrected_by": [3] } ],
  "current_custodian": { "kind": "TRANSPORT_STAFF", "name": "Riley Driver", "driver_id": "…" },
  "open_incidents": [],
  "chain_valid": true,
  "next_after_seq": null
}
```

`events` are exactly what was recorded (paged by `after_seq`/`limit`). `effective`, `current_custodian` and `open_incidents` always describe the **whole case**, not just the page. `effective` excludes `CORRECTION` rows and applies every correction in `seq` order. `open_incidents[]` is `{ seq, incident_key, severity, category, description }`. `chain_valid` is computed over the whole log from `seq` 1 and is returned only when `after_seq` is `0`; it is `null` on later pages.

---

## 8. Documents

Files live in a **private** storage bucket (`mortuary-documents`, PDF/JPEG/PNG/WebP/HEIC, ≤ 25 MB) under `<org_id>/<case_id>/<document_id>.<ext>`. Paths contain no names or case numbers. There are no public URLs: downloads use signed URLs valid for **120 seconds**, issued one at a time and audit-logged. Mortuary documents are **not** copied to a connected Google Drive.

### 8.1 Categories

`RELEASE_AUTHORIZATION`, `DEATH_CERTIFICATE`, `TRANSIT_PERMIT`, `EMBALMING_CERTIFICATE`, `NON_CONTAGION_CERTIFICATE`, `CONSULAR_DOCUMENT`, `DECEDENT_PASSPORT`, `AIRWAY_BILL`, `CARRIER_BOOKING`, `CUSTODY_ACKNOWLEDGMENT`, `IDENTIFICATION_RECORD`, `INVOICE_SUPPORT`, `OTHER`.

All categories are restricted: file downloads and review need restricted access. Metadata (category, status, timestamps) is visible to OWNER and DISPATCHER so the checklist works.

### 8.2 `Document` object

`{ id, case_id, category, status, file_name, content_type, size_bytes, uploaded_by, uploaded_at, reviewed_by, reviewed_at, review_note, version, created_at }`. Never includes `path` or a URL.

### 8.3 Endpoints

- `GET /mortuary/cases/:id/documents` → `{ documents }`
- `POST /mortuary/cases/:id/documents` → 201 `{ document, upload: { signed_url, token, expires_in_seconds: 7200 } }` (`Cache-Control: no-store`)
  `{ request_key, category, file_name (1–200), content_type, size_bytes (1–26214400) }`. Upload the bytes with a `PUT` to `signed_url` (Supabase signed upload). A replayed `request_key` returns the same document and a fresh upload URL while it is still `UPLOAD_PENDING`; once the document has moved on, `upload` is `null`.
- `POST /mortuary/cases/:id/documents/:docId/uploaded` → `{ document }` — `{ expected_version }`. The server checks the file exists in storage (`409 UPLOAD_NOT_FOUND` if not) and moves it to `RECEIVED`.
- `POST /mortuary/cases/:id/documents/:docId/review` → `{ document }` — `{ expected_version, decision: "APPROVED"|"REJECTED", note? (≤ 1000, required for REJECTED) }`. Needs restricted access; document must be `RECEIVED`.
- `POST /mortuary/cases/:id/documents/:docId/download-url` → `{ url, expires_in_seconds: 120 }` (`Cache-Control: no-store`). Needs restricted access; document must be `RECEIVED`, `APPROVED` or `REJECTED`.
- `GET /mortuary/cases/:id/checklist` →

  ```json
  { "items": [ { "category": "RELEASE_AUTHORIZATION", "sources": ["SERVICE_TYPE"], "state": "APPROVED", "document_ids": ["…"] },
               { "category": "CONSULAR_DOCUMENT", "sources": ["REQUIREMENT"], "state": "MISSING", "document_ids": [] } ],
    "complete": false,
    "notice": "Operational checklist configured by staff. It is not a statement of legal requirements." }
  ```
  `state`: `MISSING` (no document), `PENDING_UPLOAD`, `AWAITING_REVIEW` (received), `REJECTED` (only rejected documents), `APPROVED`. `sources`: `SERVICE_TYPE`, `CASE` (from `required_document_categories`), `REQUIREMENT` (from an `OPEN` or `SATISFIED` international requirement naming the category).

  Defaults by service type: `FIRST_CALL_REMOVAL` → `RELEASE_AUTHORIZATION`; `DOMESTIC_TRANSFER` and `AIRPORT_TRANSFER` → `RELEASE_AUTHORIZATION`, `TRANSIT_PERMIT`; `INTERNATIONAL_*` → `RELEASE_AUTHORIZATION`, `DEATH_CERTIFICATE`, `TRANSIT_PERMIT`, `AIRWAY_BILL`.

---

## 9. Quotes and billing

### 9.1 Objects

`Quote`: `{ id, case_id, number (Q1, Q2… per case), status, lines: ChargeLine[], subtotal_cents, currency, valid_until, notes, issued_at, accepted_at, acceptance_reference, decline_reason, version, created_at }`.

`Invoice`: `{ id, case_id, invoice_number (MI-YYYY-XXXXXX), quote_id, status, lines: ChargeLine[], subtotal_cents, currency, due_date, issued_at, voided_at, void_reason, version, payment: { status: "NOT_VERIFIED", provider: null, verified_at: null, notice } }`.

### 9.2 Endpoints

- `GET /mortuary/cases/:id/billing` → `{ quotes, invoices }`
- `POST /mortuary/cases/:id/quotes` → 201 `{ quote }` — `{ request_key, lines (1–50), valid_until (date, ≥ today), notes? (≤ 1000) }`. Created `DRAFT`. OWNER, DISPATCHER, platform key.
- `PATCH /mortuary/cases/:id/quotes/:quoteId` → `{ quote }` — `{ expected_version, lines?, valid_until?, notes? }`; `DRAFT` only.
- `POST /mortuary/cases/:id/quotes/:quoteId/issue` → `{ quote }` — `{ expected_version }`; OWNER; `DRAFT` → `ISSUED`. Any other `ISSUED` quote on the case becomes `SUPERSEDED`.
- `POST /mortuary/cases/:id/quotes/:quoteId/accept` → `{ quote }` — `{ expected_version, acceptance_reference (3–500) }`; OWNER; `ISSUED` and `valid_until` ≥ today. Records the customer's acceptance as a reference (e.g. a Mail thread id); TMS does not contact the customer.
- `POST /mortuary/cases/:id/quotes/:quoteId/decline` → `{ quote }` — `{ expected_version, reason }`; OWNER; `ISSUED` → `DECLINED`.
- `POST /mortuary/cases/:id/invoices` → 201 `{ invoice }` — `{ request_key, quote_id, additional_lines? (0–20, category ADDITIONAL only), due_date }`; OWNER; quote must be `ACCEPTED`; at most one non-void invoice per quote. Lines = quote lines (frozen) + additional lines.
- `POST /mortuary/cases/:id/invoices/:invoiceId/void` → `{ invoice }` — `{ expected_version, reason (3–500) }`; OWNER.

No endpoint sends an invoice, creates a checkout, charges a card or records a payment.

---

## 10. International coordination

### 10.1 `InternationalRecord`

| Field | Type | Notes |
|---|---|---|
| `case_id` | uuid | 1:1 with an `INTERNATIONAL_*` case |
| `origin_country`, `destination_country` | ISO alpha-2 | Different from each other |
| `transit_countries` | ISO alpha-2[] | 0–5, unique, excluding origin and destination |
| `receiving_party` | object? | `{ name, organization, role: FUNERAL_HOME|AGENT|FAMILY_REPRESENTATIVE|OTHER, phone?, email?, country, crm_contact_ref? }` |
| `carrier` | object? | `{ name, iata_code? (^[A-Z0-9]{2}$), booking_reference? (≤ 60) }` |
| `release_status` | enum | §3.5 |
| `release_approved_by`, `release_approved_at`, `release_note` | | |
| `release_snapshot` | object? | Checklist and requirement ids/review dates at approval time |
| `version` | integer | |

### 10.2 Endpoints

- `GET /mortuary/cases/:id/international` → `{ record, requirements, milestones, readiness: { ready, problems }, legal_clearance: false }`. `record` is `null` until created.
- `PUT /mortuary/cases/:id/international` → `{ record }` — `{ expected_version (0 to create), origin_country, destination_country, transit_countries, receiving_party?, carrier? }`. Changing countries after approval revokes approval (`release_status` → `REVOKED`). Only for `INTERNATIONAL_*` cases (`409 CONFLICT` otherwise).

### 10.3 Requirements

`Requirement`: `{ id, case_id, country, jurisdiction_role: ORIGIN|DESTINATION|TRANSIT|CARRIER, authority (1–200), description (1–1000), document_category?, source_type: OFFICIAL_PUBLICATION|CONSULATE_CORRESPONDENCE|CARRIER_POLICY|AGENT_ADVICE|INTERNAL_PROCEDURE, source_reference (3–1000: URL, letter reference or citation), reviewed_on (date), reviewed_by, status, status_note, stale, version }`.

- `POST /mortuary/cases/:id/international/requirements` → 201 `{ requirement }` — `{ request_key, country, jurisdiction_role, authority, description, document_category?, source_type, source_reference, reviewed_on }`. `reviewed_on` ≤ today. `country` must be the record's origin, destination or a transit country (any for `CARRIER`).
- `PATCH /mortuary/cases/:id/international/requirements/:reqId` → `{ requirement }` — `{ expected_version, status?, status_note?, source_reference?, reviewed_on? }`. `NOT_APPLICABLE` requires `status_note`. Changing a requirement after approval revokes approval.
- Adding a requirement after approval also revokes approval (`release_status` → `REVOKED`); an owner must approve again.

### 10.4 Milestones (append-only)

`Milestone`: `{ id, case_id, kind, occurred_at, reference?, location_country?, note?, supersedes_id?, recorded_by, created_at }`.

`kind`: `DOCUMENTS_SUBMITTED`, `CONSULAR_DOCUMENT_RECEIVED`, `CARRIER_BOOKED`, `TENDERED_TO_CARRIER`, `DEPARTED`, `TRANSIT_STOP`, `ARRIVED`, `CUSTOMS_PROCESSED`, `RELEASED_TO_RECEIVING_PARTY`, `OTHER`.

- `POST /mortuary/cases/:id/international/milestones` → 201 `{ milestone }` — `{ request_key, kind, occurred_at, reference?, location_country?, note?, supersedes_id? }`. To correct a milestone, post a new one with `supersedes_id`; the original is kept. `CARRIER_BOOKED` records a booking someone made outside TMS; TMS books nothing.

### 10.5 Release approval (OWNER, signed-in person)

- `POST /mortuary/cases/:id/international/release-approval` → `{ record, legal_clearance: false }`

  ```json
  { "expected_version": 4, "acknowledge": "I have reviewed the documents and requirements for this case. This is an internal release decision, not legal clearance.", "note": "Fixture approval" }
  ```
  `acknowledge` must equal that sentence exactly. Blocked with `409 NOT_READY` and `problems` when: onboarding incomplete; record missing; any requirement `OPEN` or stale; any checklist item not `APPROVED`; no `receiving_party`; an unresolved incident. Approval does not change the case status and does not book transport.
- `POST /mortuary/cases/:id/international/release-approval/revoke` → `{ record }` — `{ expected_version, reason (3–500) }`.

---

## 11. Integration events (outbox)

TMS records explicit, minimal events for other Onixus systems. **No consumer is implemented in this release; events stay `PENDING`.** Nothing is sent to CRM, Mail or Signal.

- `GET /mortuary/cases/:id/integration-events` → `{ events: [{ id, target, kind, payload, status, created_at, delivered_at }] }`
- `target`: `CRM` or `MAIL` only (database-enforced; `SIGNAL` is rejected).
- `kind`: `case.opened`, `case.status_changed`, `invoice.issued`.
- `payload` is built from an allow-list: `{ case_id, case_number, service_type, status, crm_system?, crm_account_ref?, mail_thread_refs?, invoice_number?, subtotal_cents? }`. It never contains decedent data, places, contacts, documents or custody details. `invoice.issued` goes to `CRM` only.
- An event is queued for a target only when the case carries that target's reference.

---

## 12. Audit

Restricted reads/writes, document download URLs, document reviews, access grants/revokes and release approvals/revocations are written to an append-only access log (`case_id`, actor, action, target id, time). This release has no endpoint to read it; owners can query it in Supabase.

Server logs never include request bodies for mortuary routes. Error messages never echo restricted fields.

---

## Change log

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-22 | Initial frozen contract (committed before implementation). |
| 1.1.0 | 2026-10-22 | Additive / clarifying only, found while implementing. No field, status or rule was removed or renamed. (1) §7.3: `effective`, `current_custodian`, `open_incidents` always cover the whole case; `open_incidents[]` shape defined; `chain_valid` only when `after_seq=0`. (2) §8.3: document replay returns `upload: null` once the document is past `UPLOAD_PENDING`. (3) §9.1: `Quote.decline_reason` added. (4) §4.7: `actor.role` added to history. (5) §10.3: adding a requirement after approval revokes approval, like changing one. |
