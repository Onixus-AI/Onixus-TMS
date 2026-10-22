# Mortuary integration — 2026-10-22

Combines backend foundation PR #15 (contract 1.1.0) with the supplied frontend patch, plus private document upload/download/review forms. Freight remains a separate operational area. No production migration, client provisioning, email, charge or booking was performed.

Document forms validate supported MIME types and 25 MB size, reuse the same request key/file on retries, confirm storage before claiming receipt, and separate upload from review. Restricted review controls are hidden for unauthorized staff; the API remains authoritative.

Verification: 53 API tests pass against the in-memory store; core tests pass (18); web tests and TypeScript/build results recorded in the PR. PostgreSQL concurrency checks and real Supabase Storage have not been rerun in this environment.

Remaining release gaps: driver status/custody forms, quote/invoice actions, case/leg editing and transitions, international requirement/milestone editing, pagination beyond 100 cases, integration outbox consumer, staging acceptance and deployment. This is an integration increment, not completed Thompson onboarding.

Initial audit reported four affected packages. This increment pins Vitest 4.1.12 and MCP SDK 1.32.1; the updated npm audit reports zero known vulnerabilities. Test tooling must not be exposed as a network service.

## Workflow increment — 2026-10-22
Office controls now support case details/status, restricted records, transport leg creation/rescheduling/status, carrier assignment/unassignment, draft quote edits, quote issue/accept/decline, invoice issue/void, international route/requirements/milestones and staff-release revocation. Existing dispatch assignment and release approval remain in place. Driver controls add status and identity/transfer custody writes. Safe retries retain the submitted values and request key; failed version checks require reloading the case.

Contract 1.2.0 adds whole-case `last_seq` to custody reads. Driver responses still exclude other legs' events and case-wide details. The case list loads up to 2,000 records and refuses to present a silently incomplete list beyond that bound.

Validation: 53 API tests pass; 12 web tests pass (serial rerun after one resource-related five-second timeout); TypeScript and production web build pass. Migration 015 and SQL assertions pass with embedded PGlite PostgreSQL, using the existing SQL fixtures. Native PostgreSQL initdb was blocked by the execution environment's shared-memory restriction, so the two-session race script was not rerun. No hosted staging branch exists. Real Storage and authenticated client acceptance remain outstanding.

See thompson-onboarding-checklist.md for the owner setup and rehearsal gates. No mortuary production migration or deployment was performed.

Embedded checks can be rerun with `MORTUARY_PGLITE_MODULE=<absolute-module-entrypoint> node scripts/test-mortuary-embedded.mjs`. The native PostgreSQL script remains the authority for two-session race acceptance.
