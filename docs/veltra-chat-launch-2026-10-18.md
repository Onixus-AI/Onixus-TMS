# Veltra Chat launch plan — 18 October 2026

## Decision

Launch a supervised, invitation-only beta after the security and provider gates below pass. Do not advertise the network as foolproof, full autonomous store management, completed nationwide mortuary compliance, or a live Gather connection. This review is configuration inspection, source review and functional testing; it is not a penetration test.

## Security evidence

| Area | Observed evidence | Remaining gate |
| --- | --- | --- |
| Railway database network | TMS and standalone Mail Postgres services have private endpoints, no public domains and no TCP proxies | Verify backups and perform a restore drill; inspect all other project databases before making an organization-wide claim |
| TMS API | Unauthenticated `/operations` returns 401; company-scoped data access and tests | Independent cross-tenant penetration testing, edge abuse limits and alerting |
| Supabase | RLS and server-only grants retained; mortuary setup column verified with RLS enabled and no anonymous SELECT or authenticated browser UPDATE | Leaked-password protection disabled on Chat/CRM and TMS projects; enable and recheck before public launch |
| Mail browser requests | New central cross-site write rejection for cookie API; regression checks cover malicious Origin and Fetch Metadata | Live browser regression and broader CSRF review of all login/approval endpoints |
| Service connections | Onixus URL input restricted to the server-configured HTTPS origin; provider HTTP redirects rejected; Shopify shop hosts restricted to `*.myshopify.com` | Review all legacy saved connections and callback destinations, rotate any previously exposed credentials |
| Dependencies | Initial scan found MCP SDK OAuth, PostCSS and KaTeX advisories. Patched MCP SDK to 1.31.0, PostCSS to 8.5.23 and KaTeX to 0.18.2 using exact versions/overrides | Recheck clean install, audit and builds; monitor new advisories |
| Browser headers | Mail/TMS add nosniff, framing/referrer controls and HTTPS HSTS; Chat adds framing/nosniff/referrer and microphone policy | Recheck headers after deployment; full CSP/XSS review still needed |
| RPC advisors | Existing security-definer warnings remain on token-protected Mail bridges and owner-gated discovery functions | Review each callable function's authorization before public launch; warnings are not dismissed as proof of safety |
| Monitoring | Existing deployment health checks are configured | Verify error alerts, authentication abuse alerts, audit retention, rollback and incident owners |

No passwords, store/customer credentials, Zee client data or mailbox messages were copied into this report.

## Cluster cleanup

The TMS project contains an extra `onyx-mail` deployment from the same Mail repository. Its live health response is `ready:false` because required application credentials are absent. Polling is now configured off (`POLL_SECONDS=0`) and sleep mode enabled. No database or service was deleted. Railway's configuration interface rejects zero replicas, so this is containment, not completed removal or verified cost elimination. Confirm data/dependency inventory and retain a backup before final service retirement. Keep standalone Mail as the canonical Mail endpoint.

Separate Chat/CRM, Mail and TMS databases are acceptable. Keep explicit ownership and integration events; do not merge databases just to achieve synchronization. Old CRM storage and both Onixus organizations remain separate.

## Product release scope

| Product area | This implementation | Not yet a live guarantee |
| --- | --- | --- |
| UI | Existing Chat layout retained. Available connections are shown first; planned tools can be revealed. Dedicated Shopify panel with status, setup and review forms | Mobile, keyboard and assistive technology acceptance across every screen |
| Email testing | Mail Test inbox contains five fictional `.test` examples: combined quote, missing price input, mortuary intake, unsubscribe and DSN | It is a scenario preview. It does not run the model, put messages into Gmail, send mail or verify real quotation delivery |
| Shopify | Per-Veltra-user OAuth binding; expiring encrypted tokens and refresh; owner-controlled public install flag; read catalog; separately enabled title-edit proposal/confirmation; single-use review tickets; stale-product and connection-version checks; signed uninstall/privacy callbacks | Public app registration and distribution approval, real merchant OAuth, real refresh/uninstall lifecycle and live title-edit test; orders, refunds, discounts, inventory writes, CRM customer sync and multi-store switching are not implemented |
| Mortuary | Each business can enable MORTUARY, save dispatch/coverage/procedure references and six owner-reviewed checks. Quote acceptance and booking require complete setup and a case/release reference. Completion requires signed custody document reference | Qualified nationwide coverage, jurisdiction-specific requirements and credentials, client training, actual custody workflow and external provider authorization. A checkbox is not regulatory certification |
| Veltra Gather | Read-only MCP adapter reuses Zee's checked-in event/task/vendor/budget/timeline model. Caller JWT is verified against a configured backend, then explicit event ownership and backend RLS apply. Bounded results; no guest contacts or credentials selected | Customer sign-in bridge, approved backend project/configuration, partner/team permission model, workspace UI and write tools. Endpoint is disabled by default. Zee's live app, data and branding remain untouched |

Shopify connections are user scoped in this beta, with one store per Veltra account. Workspace team delegation and multiple stores require a dedicated merchant/role model. Product title review compares current title and updatedAt before submitting, but Shopify does not provide an atomic compare-and-swap here; avoid simultaneous manual edits during the pilot. An uncertain write is not retried with the consumed ticket; refresh Shopify and inspect the product before proposing another change.

## Shopify customer installation

Customer flow: sign into Veltra → open Shopify connector → enter store.myshopify.com → approve Veltra in Shopify → return to the connected store panel. A user's ChatGPT Shopify connection does not install Veltra for other customers.

Use a publicly distributed Shopify app for unrelated customer stores. A custom distribution is limited to one store or stores in the same Plus organization (and development stores); public distribution requires Shopify approval. Do not promise that any merchant can install until approval is granted.

Platform setup uses the Shopify Dev Dashboard and secrets manager, never pasted credentials in chat:

- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` on standalone Mail.
- Callback: `https://veltra-production-5b9c.up.railway.app/shopify/callback`.
- Signed webhook endpoint: `https://veltra-production-5b9c.up.railway.app/shopify/webhooks`.
- Initial scope `read_products`. `SHOPIFY_PRODUCT_WRITES_ENABLED=true` additionally requires `write_products` and explicit merchant consent.
- Keep `SHOPIFY_PUBLIC_INSTALL_ENABLED` unset until app registration, privacy/uninstall delivery tests and distribution gates pass.
- Review `shopify.app.toml.example`; it is a template, not an installed Shopify application.
- Current data scope is product catalog only. Protected customer/order data needs separate approved permissions, minimization, retention and deletion handling.

Official references: https://shopify.dev/docs/apps/launch/distribution ; https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps ; https://shopify.dev/docs/apps/build/webhooks/subscribe . GraphQL operations were validated against API 2026-07 with Shopify's bundled validator.

## Gather backend reuse

Adapter endpoint: standalone Mail `/integrations/gather/mcp`, POST. Tools: `list_events` (50 owned events) and `event_overview` (200 rows per section). It accepts a user's token issued by the configured event backend, not a Chat token from a different Supabase project. There is no service-role fallback. It deliberately excludes partner/admin broad access until a reviewed role model exists.

Required platform configuration: `GATHER_MCP_ENABLED=true`, `GATHER_SUPABASE_URL`, `GATHER_SUPABASE_PUBLIC_KEY`. Leave unset for this release. Before enabling, choose an approved isolated backend with the Zee-compatible schema/RLS and implement the customer authorization bridge. Do not point it at Zee's client production project as an accidental shortcut. Working brand: **Veltra Gather**; no trademark/domain availability claim is made.

## Launch sequence and exit criteria

1. **Security gate — platform owner + engineering.** Enable leaked-password protection; verify least-privilege secrets, backups/restore, edge rate limits, audit logs and alerting. Resolve high-severity findings. Record a rollback deployment and incident contact.
2. **Internal acceptance — engineering + Onixus operator.** Run isolated quotation fixtures; use a designated test mailbox for true receive → quote → acceptance flow after explicit sending authorization. Verify tenant A cannot read or change tenant B. Verify mobile sidebar, history, connector forms, error states and real voice transcription with mic consent. Keep outreach paused.
3. **Drayage pilot — Onixus owner.** Confirm the actual ports/warehouse radius and rates. Complete the pending Onixus-only Mail/CRM/TMS authorization. Authorize the intended Stripe account and Google Calendar. Test using provider test mode before any live charge/booking. Confirm one quote total and the same customer/job identifiers across apps.
4. **Mortuary pilot — client owner + qualified operations reviewer.** Create the client's own company and accounts; enter dispatch/coverage/rates and restricted SOP references; review each applicable area and partner; train a dispatcher; rehearse an operational case using fictional references. Only then approve supervised client onboarding. Do not collect decedent/medical identity in ordinary chat.
5. **Commerce and Gather pilot — app owner + one consenting client.** Finish Shopify app registration/distribution and test install, revocation and reviewed edits. Complete Gather sign-in/backend/UI independently. Expand capabilities only after their permissions and failure/recovery paths are tested.
6. **Limited beta → public launch.** Require zero unresolved cross-tenant failures, zero duplicate sends/charges/bookings in acceptance tests, all supported quote scenarios correct, successful restore/rollback drills, working alerts and an identified support owner. Observe a seven-day supervised beta with no critical incident before widening access. Report actual outcomes rather than an invented reliability percentage.

Remaining inputs: the mortuary client's business name/owner account and approved operating documents; Shopify app registration/distribution status; provider authorizations. No real customer email, payment, booking or outreach campaign was executed for these tests.

## Validation record

- Mail clean install, TypeScript and all 82 tests passed; Mail UI production build passed.
- TMS TypeScript, all 50 tests (41 API + 9 core), and production build passed.
- Chat clean install and production build passed; KaTeX render smoke check passed. A Node-only Mermaid parse check cannot initialize DOMPurify without a browser DOM; browser diagram behavior is not certified by that check.
- Production dependency audits are recorded separately for Mail, TMS and Chat; zero known findings is a registry snapshot, not a security guarantee.
- Shopify GraphQL queries/mutation validated against 2026-07. Shopify API/network calls are mocked in product-edit tests. Real merchant install, token refresh, title edit, privacy/uninstall delivery and app distribution are not verified live.
- Gather owner filtering and original JWT forwarding are tested using mocked responses, not Zee production data.
- No real email, model generation, payment, calendar booking or outreach send was executed.
