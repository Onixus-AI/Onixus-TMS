# Mortuary UI status

The office and driver screens in `apps/web` follow Onixus TMS–Mortuary API contract **1.1.0** from pull request #15 (`docs/mortuary-api-contract.md` on `mortuary-backend-foundation`). This branch does not edit that contract, the mortuary migration, authorization policies, backend routes, or shared authentication.

This integration branch includes backend pull request #15. Live integration is not complete until a staging migration and signed-in storage rehearsal pass. These UI tests use a contract-shaped mock. They are not live backend acceptance.

## Screens

| Screen | Where | Contract calls |
|---|---|---|
| Operations | Mortuary area, Operations | `GET /mortuary/cases`, `GET /mortuary/dispatch/board`, `GET /mortuary/cases/:id/checklist`, `GET /mortuary/cases/:id` for international release |
| Case list and intake | Cases | `GET /mortuary/cases`, `POST /mortuary/cases` |
| Case workspace | A case | Detail, legs, custody, checklist, billing, history, integration events, restricted record |
| Dispatch | Dispatch | `GET /mortuary/dispatch/board`, `POST .../assignment`, fleet `GET /drivers` and `GET /trucks` |
| Custody | Case tab | `GET/POST /mortuary/cases/:id/custody-events` |
| Documents | Case tab | `GET /mortuary/cases/:id/checklist` |
| Quote preview | Case tab | `GET /mortuary/cases/:id/billing` |
| International | Area and case tab | `GET /mortuary/cases/:id/international`, `POST .../release-approval` |
| Driver legs | Driver app, Mortuary legs | `GET /driver/mortuary/legs` |
| Connections | Operations | Links only. Outbox is read with `GET .../integration-events` |

Freight tabs are unchanged. Mortuary is a second area in the same sidebar.

## What the client does not invent

- There is no dashboard endpoint. Counts are derived. "Past scheduled arrival" is an open leg whose scheduled arrival has passed. The API has no delayed status.
- The case list has no text search. Search filters the loaded page (up to 100 cases).
- Checklist rows and the notice come from `GET /checklist`. The UI does not add a legal document list.
- `documents complete` is `checklist.complete`. `cleared for transport` is `release_status === APPROVED`. `legal_clearance` is shown from the response.
- Custody and release receipts render only after the response. A typed-name acknowledgement is not described as a stored signature image.
- The HTTP client throws on failure. It does not fill the screen with sample cases.
- Signal has no link and no outbox target. CRM and Mail links are marked not verified production-ready. The outbox stays unread by any sender in this UI.

## Tests

`npm test --workspace @onixus/web` covers queue counts, restricted names omitted from the operations snapshot, HTTP errors without sample substitution, queue navigation, the checklist notice, the clearance split, a failed then confirmed identity check, and the unpaid quote preview.

## Remaining gaps

1. Backend and frontend are combined on the integration branch; production main has not been changed. Staging migration, private storage and authenticated acceptance remain required.
2. Document upload, private download and restricted review now have forms. Failed uploads reuse their request key. Real signed storage upload/download still needs staging verification.
3. Driver status and identity/transfer custody forms are implemented against contract 1.2.0. Hosted authenticated driver acceptance is pending.
4. Office write controls now cover quotes/invoices and international requirements/milestones. Provider payment collection remains disconnected.
5. Case list loads at most 2,000 cases and errors beyond that bound instead of showing a silently incomplete result.
6. Fleet labels depend on the existing `/drivers` and `/trucks` payloads.
7. No mortuary production migration/deployment, billing, email or booking was performed. An empty client organization and pending owner invitation were reserved through the existing account tables.
