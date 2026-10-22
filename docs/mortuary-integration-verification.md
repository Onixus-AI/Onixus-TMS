# Mortuary integration — 2026-10-22

Combines backend foundation PR #15 (contract 1.1.0) with the supplied frontend patch, plus private document upload/download/review forms. Freight remains a separate operational area. No production migration, client provisioning, email, charge or booking was performed.

Document forms validate supported MIME types and 25 MB size, reuse the same request key/file on retries, confirm storage before claiming receipt, and separate upload from review. Restricted review controls are hidden for unauthorized staff; the API remains authoritative.

Verification: 53 API tests pass against the in-memory store; core tests pass (18); web tests and TypeScript/build results recorded in the PR. PostgreSQL concurrency checks and real Supabase Storage have not been rerun in this environment.

Remaining release gaps: driver status/custody forms, quote/invoice actions, case/leg editing and transitions, international requirement/milestone editing, pagination beyond 100 cases, integration outbox consumer, staging acceptance and deployment. This is an integration increment, not completed Thompson onboarding.

Dependency audit currently reports four advisories (MCP SDK high, Vitest/tinypool critical, Vitest mocker moderate); no automatic fix is available from the lockfile audit. Test tooling must not be exposed as a network service. Dependency remediation remains a release concern.
