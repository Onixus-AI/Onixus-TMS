// TMS–Mortuary API tests. All data is fictional. The in-memory store is
// wrapped with the same unique constraints as 015_mortuary_cases.sql so that
// races resolve the way they do in Postgres. Database-only guarantees (the
// locked overlap check, append-only triggers, hash linkage) are exercised
// against real PostgreSQL in supabase/tests/mortuary_015_test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { memoryStore, StoreError, type FileStore, type Row, type Store } from "@onixus/providers";
import { RELEASE_ACKNOWLEDGEMENT } from "@onixus/core";

const KEY = "test-key-0123456789abcdefghij";
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002";
const NOW = "2026-10-22T12:00:00.000Z";
const DECEDENT = "Jordan Fixture-Decedent";
const TAG = "TAG-FIXTURE-7781";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const M = { ownerA: id(1), dispA: id(2), disp2A: id(3), driverA: id(4), ownerB: id(5), driver2A: id(6), noOnboardOwner: id(7) };
const D = { d1: id(11), d2: id(12), dB: id(13) }, V = { v1: id(21), v2: id(22), vB: id(23) };
const SETUP = { dispatch_phone: "+1 404 555 0100", coverage: "Fixture coverage", procedure_reference: "SOP-FIXTURE", checks: ["coverage", "release", "custody", "staff", "pricing", "privacy"], reviewed_at: NOW, reviewed_by: "fixture" };

/** Unique constraints from the migration, checked synchronously so two concurrent inserts cannot both pass. */
const UNIQUE: Record<string, string[][]> = {
  mortuary_cases: [["org_id", "request_key"], ["org_id", "case_number"]],
  mortuary_case_status_events: [["org_id", "request_key"]],
  mortuary_transport_legs: [["org_id", "request_key"], ["case_id", "seq"]],
  mortuary_custody_events: [["org_id", "request_key"], ["case_id", "seq"]],
  mortuary_documents: [["org_id", "request_key"]],
  mortuary_quotes: [["org_id", "request_key"], ["case_id", "number"]],
  mortuary_invoices: [["org_id", "request_key"], ["org_id", "invoice_number"]],
  mortuary_requirements: [["org_id", "request_key"]],
  mortuary_milestones: [["org_id", "request_key"]],
  mortuary_international: [["id"]],
  mortuary_case_restricted: [["id"]],
};
function constrained(base: ReturnType<typeof memoryStore>): Store & { tables: Record<string, Row[]> } {
  return {
    ...base,
    insert(table, row) {
      for (const cols of UNIQUE[table] ?? []) {
        if (cols.every((c) => row[c] != null) && (base.tables[table] ?? []).some((r) => cols.every((c) => r[c] === row[c]))) {
          return Promise.reject(new StoreError(409, `Database: duplicate key value violates unique constraint (${cols.join(",")})`));
        }
      }
      return base.insert(table, row);
    },
  };
}

function world(opts: { mortuaryB?: boolean } = {}) {
  const users: Record<string, { id: string; email: string }> = {};
  const memberships: Row[] = [];
  const add = (m: string, org: string, role: string, driver_id: string | null = null) => {
    users[`tok-${m}`] = { id: `user-${m}`, email: `${m}@example.test` };
    memberships.push({ id: m, org_id: org, user_id: `user-${m}`, email: `${m}@example.test`, role, driver_id });
  };
  add(M.ownerA, A, "OWNER"); add(M.dispA, A, "DISPATCHER"); add(M.disp2A, A, "DISPATCHER"); add(M.driverA, A, "DRIVER", D.d1); add(M.driver2A, A, "DRIVER", D.d2); add(M.ownerB, B, "OWNER");
  const base = memoryStore({
    organizations: [{ id: A, name: "Fixture Mortuary A" }, { id: B, name: "Fixture Mortuary B" }],
    memberships,
    api_keys: [{ id: id(90), org_id: A, hash: createHash("sha256").update("onx_fixture_company_key").digest("hex"), revoked_at: null }],
    transport_profiles: [{ id: A, org_id: A, modules: ["MORTUARY"], mortuary_setup: SETUP }, ...(opts.mortuaryB === false ? [] : [{ id: B, org_id: B, modules: ["MORTUARY"], mortuary_setup: SETUP }])],
    drivers: [{ id: D.d1, org_id: A, name: "Riley Driver", status: "AVAILABLE" }, { id: D.d2, org_id: A, name: "Sam Driver", status: "AVAILABLE" }, { id: D.dB, org_id: B, name: "Other Driver", status: "AVAILABLE" }],
    trucks: [{ id: V.v1, org_id: A, truck_number: "RV-1", kind: "CARGO_VAN", status: "AVAILABLE" }, { id: V.v2, org_id: A, truck_number: "RV-2", kind: "CARGO_VAN", status: "AVAILABLE" }, { id: V.vB, org_id: B, truck_number: "RV-B", status: "AVAILABLE" }],
  });
  const db = constrained(base);
  const present = new Set<string>();
  const signedFor: { path: string; seconds?: number }[] = [];
  const mortuaryFiles: FileStore = {
    uploadUrl: async (path) => ({ path, token: "upload-token", signedUrl: `https://storage.example.test/upload/sign/${randomUUID()}` }),
    downloadUrl: async (path, seconds) => (signedFor.push({ path, seconds }), `https://storage.example.test/object/sign/${randomUUID()}?expires=${seconds}`),
    exists: async (path) => present.has(path),
    download: async () => { throw new Error("not used"); },
  };
  const logs: string[] = [];
  const app = createApp({ TMS_API_KEY: KEY }, {
    store: () => db,
    now: () => new Date(NOW),
    verifyUser: async (t) => users[t] ?? null,
    mortuaryFiles: () => mortuaryFiles,
    files: () => { throw new Error("Mortuary documents must never touch the loads bucket or Drive"); },
  });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const auth: Record<string, string> = who === "platform" ? { Authorization: `Bearer ${KEY}`, "X-Org-Id": A } : who === "platform-noorg" ? { Authorization: `Bearer ${KEY}` } : who === "companykey" ? { Authorization: "Bearer onx_fixture_company_key" } : { Authorization: `Bearer tok-${who}` };
    const r = await fetch(url + path, { method, headers: { "Content-Type": "application/json", ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers, raw: text };
  };
  return { db, call, present, signedFor, logs, close: () => server.close() };
}

type W = ReturnType<typeof world>;
const place = (name: string, facility_type = "HOSPITAL", country = "US") => ({ name, facility_type, city: "Atlanta", region: "GA", country });
const newCase = (over: Record<string, unknown> = {}) => ({
  request_key: randomUUID(), service_type: "DOMESTIC_TRANSFER",
  requesting_organization: { name: "Example Family Funeral Home", type: "FUNERAL_HOME", phone: "+1 404 555 0101", email: "intake@example-fh.test" },
  authorized_contacts: [{ name: "Alex Sample", relationship: "FUNERAL_DIRECTOR", may_authorize_release: true }],
  origin: place("Example General Hospital"), destination: place("Example Family Funeral Home", "FUNERAL_HOME"), ...over,
});
async function makeCase(w: W, who = M.dispA, over: Record<string, unknown> = {}) {
  const r = await w.call(who, "POST", "/mortuary/cases", newCase(over));
  assert.equal(r.status, 201, r.raw);
  return r.body.case;
}
/** Upload, confirm and approve one document; returns it. */
async function approvedDoc(w: W, caseId: string, category: string) {
  const made = await w.call(M.dispA, "POST", `/mortuary/cases/${caseId}/documents`, { request_key: randomUUID(), category, file_name: "scan.pdf", content_type: "application/pdf", size_bytes: 1000 });
  assert.equal(made.status, 201, made.raw);
  const row = w.db.tables.mortuary_documents.find((d) => d.id === made.body.document.id)!;
  w.present.add(String(row.path));
  const up = await w.call(M.dispA, "POST", `/mortuary/cases/${caseId}/documents/${row.id}/uploaded`, { expected_version: 1 });
  assert.equal(up.status, 200, up.raw);
  const rev = await w.call(M.ownerA, "POST", `/mortuary/cases/${caseId}/documents/${row.id}/review`, { expected_version: 2, decision: "APPROVED" });
  assert.equal(rev.status, 200, rev.raw);
  return rev.body.document;
}
async function transition(w: W, caseId: string, to: string, reason?: string, who = M.dispA) {
  const cur = (await w.call(who, "GET", `/mortuary/cases/${caseId}`)).body.case;
  return w.call(who, "POST", `/mortuary/cases/${caseId}/transitions`, { request_key: randomUUID(), to, expected_version: cur.version, ...(reason ? { reason } : {}) });
}
async function lastSeq(w: W, caseId: string) {
  const r = await w.call(M.dispA, "GET", `/mortuary/cases/${caseId}/custody-events`);
  return r.body.events.length ? r.body.events.at(-1).seq : 0;
}
const ack = (name: string) => ({ method: "TYPED_NAME", typed_name: name, acknowledged_at: "2026-10-22T11:55:00.000Z" });
const custody = (kind: string, payload: Record<string, unknown>, expected_seq: number, leg_id?: string) => ({ request_key: randomUUID(), expected_seq, kind, ...(leg_id ? { leg_id } : {}), occurred_at: "2026-10-22T11:55:00.000Z", payload });

// ─────────────────────────────────────────────────────────────────────────────

test("tenant isolation: another company's case, legs, documents and drivers read as missing", async () => {
  const w = world();
  try {
    const c = await makeCase(w);
    const leg = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("Origin"), to: place("Dest", "FUNERAL_HOME"), scheduled_departure_at: "2026-10-22T13:00:00.000Z", scheduled_arrival_at: "2026-10-22T15:00:00.000Z" })).body.leg;
    assert.equal((await w.call(M.ownerB, "GET", `/mortuary/cases/${c.id}`)).status, 404);
    assert.equal((await w.call(M.ownerB, "GET", `/mortuary/cases`)).body.cases.length, 0);
    assert.equal((await w.call(M.ownerB, "PATCH", `/mortuary/cases/${c.id}`, { expected_version: 1, crm_account_ref: "x" })).status, 404);
    assert.equal((await w.call(M.ownerB, "POST", `/mortuary/cases/${c.id}/transitions`, { request_key: randomUUID(), to: "AWAITING_RELEASE", expected_version: 1 })).status, 404);
    assert.equal((await w.call(M.ownerB, "GET", `/mortuary/cases/${c.id}/legs`)).status, 404);
    assert.equal((await w.call(M.ownerB, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CHECKPOINT", { type: "ARRIVED" }, 0))).status, 404);
    assert.equal((await w.call(M.ownerB, "GET", `/mortuary/cases/${c.id}/restricted`)).status, 404);
    assert.equal((await w.call(M.ownerB, "GET", `/mortuary/cases/${c.id}/integration-events`)).status, 404);
    // Company B's driver and vehicle cannot be put on company A's leg.
    const r = await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/assignment`, { expected_version: 1, driver_id: D.dB, vehicle_id: V.vB, dry_run: true });
    assert.deepEqual(r.body.problems, ["Driver not found", "Vehicle not found"]);
    // The platform key acts only inside the organization it names.
    assert.equal((await w.call("platform", "GET", `/mortuary/cases/${c.id}`, undefined, { "X-Org-Id": B })).status, 404);
    assert.equal((await w.call("platform", "GET", `/mortuary/cases/${c.id}`)).status, 200);
  } finally { w.close(); }
});

test("role restrictions: drivers, company keys and machines are kept out of what is not theirs", async () => {
  const w = world();
  try {
    const c = await makeCase(w);
    const driver = await w.call(M.driverA, "GET", "/mortuary/cases");
    assert.equal(driver.status, 403); assert.equal(driver.body.code, "FORBIDDEN");
    const company = await w.call("companykey", "GET", "/mortuary/cases");
    assert.equal(company.status, 403); assert.equal(company.body.code, "FORBIDDEN", "a valid company key (e.g. Veltra) never reaches mortuary routes");
    assert.equal((await w.call("companykey", "GET", "/driver/mortuary/legs")).body.code, "FORBIDDEN");
    assert.equal((await w.call("platform-noorg", "GET", "/mortuary/cases")).status, 400);
    // Restricted: owner yes; dispatcher only with a grant or as coordinator; platform never.
    const rec = { expected_version: 0, decedent_full_name: DECEDENT, date_of_death: "2026-10-21", id_tag_number: TAG };
    assert.equal((await w.call(M.dispA, "PUT", `/mortuary/cases/${c.id}/restricted`, rec)).body.code, "RESTRICTED_ACCESS_REQUIRED");
    assert.equal((await w.call(M.ownerA, "PUT", `/mortuary/cases/${c.id}/restricted`, rec)).status, 200);
    assert.equal((await w.call("platform", "GET", `/mortuary/cases/${c.id}/restricted`)).body.code, "FORBIDDEN");
    assert.equal((await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/restricted`)).status, 403);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/access`, { member_id: M.dispA })).status, 403, "dispatchers cannot grant themselves access");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/access`, { member_id: M.driverA })).status, 400, "drivers cannot be granted case access");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/access`, { member_id: M.dispA })).status, 201);
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/access`, { member_id: M.dispA })).status, 200, "granting twice returns the active grant");
    const seen = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/restricted`);
    assert.equal(seen.status, 200); assert.equal(seen.body.record.decedent_full_name, DECEDENT); assert.equal(seen.headers.get("cache-control"), "no-store");
    assert.equal((await w.call(M.disp2A, "GET", `/mortuary/cases/${c.id}/restricted`)).status, 403, "a grant is per member");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/access/${M.dispA}/revoke`)).status, 200);
    assert.equal((await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/restricted`)).status, 403);
    // The coordinator has access without a grant.
    const cur = (await w.call(M.ownerA, "GET", `/mortuary/cases/${c.id}`)).body.case;
    await w.call(M.ownerA, "PATCH", `/mortuary/cases/${c.id}`, { expected_version: cur.version, coordinator_member_id: M.disp2A });
    assert.equal((await w.call(M.disp2A, "GET", `/mortuary/cases/${c.id}/restricted`)).status, 200);
    // Owner-only billing and release actions.
    const q = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/quotes`, { request_key: randomUUID(), lines: [{ category: "SERVICE", description: "Transfer", quantity: 1, unit_cents: 45000 }], valid_until: "2026-11-01" });
    assert.equal(q.status, 201);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/quotes/${q.body.quote.id}/issue`, { expected_version: 1 })).status, 403);
    assert.equal((await w.call("platform", "POST", `/mortuary/cases/${c.id}/quotes/${q.body.quote.id}/issue`, { expected_version: 1 })).status, 403);
    // Every restricted read and write was audited, without content.
    const log = w.db.tables.mortuary_access_log;
    assert.ok(log.some((l) => l.action === "RESTRICTED_WRITE") && log.some((l) => l.action === "RESTRICTED_READ") && log.some((l) => l.action === "ACCESS_GRANTED") && log.some((l) => l.action === "ACCESS_REVOKED"));
    assert.ok(!JSON.stringify(log).includes(DECEDENT));
  } finally { w.close(); }
});

test("restricted decedent data never appears outside the restricted record", async () => {
  const w = world();
  try {
    const c = await makeCase(w, M.dispA, { crm_system: "RELAY", crm_account_ref: "relay-acct-fixture", mail_thread_refs: ["thread-fixture-1"] });
    await w.call(M.ownerA, "PUT", `/mortuary/cases/${c.id}/restricted`, { expected_version: 0, decedent_full_name: DECEDENT, date_of_birth: "1950-01-02", date_of_death: "2026-10-21", id_tag_number: TAG, handling_notes: "Fixture handling note" });
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("IDENTITY_CHECK", { method: "TAG", outcome: "VERIFIED", observed_tag: TAG.toLowerCase() }, 0));
    await transition(w, c.id, "AWAITING_RELEASE");
    const surfaces = await Promise.all([
      w.call(M.ownerA, "GET", `/mortuary/cases/${c.id}`), w.call(M.ownerA, "GET", "/mortuary/cases"), w.call(M.ownerA, "GET", `/mortuary/cases/${c.id}/history`),
      w.call(M.ownerA, "GET", `/mortuary/cases/${c.id}/integration-events`), w.call(M.ownerA, "GET", `/mortuary/cases/${c.id}/custody-events`), w.call(M.ownerA, "GET", `/mortuary/cases/${c.id}/checklist`),
    ]);
    for (const s of surfaces) {
      assert.equal(s.status, 200);
      for (const secret of [DECEDENT, TAG, "1950-01-02", "Fixture handling note"]) assert.ok(!s.raw.toUpperCase().includes(secret.toUpperCase()), `leaked ${secret}`);
    }
    // The observed tag was compared, not stored.
    const ev = surfaces[4].body.events[0];
    assert.equal(ev.payload.tag_check, "MATCH"); assert.equal(ev.payload.observed_tag, undefined);
    assert.ok(!JSON.stringify(w.db.tables.mortuary_custody_events).toUpperCase().includes(TAG));
    // Integration events: CRM and Mail only, allow-listed fields only, never Signal.
    const events = surfaces[3].body.events;
    assert.deepEqual([...new Set(events.map((e: Row) => e.target))].sort(), ["CRM", "MAIL"]);
    const allowed = new Set(["case_id", "case_number", "service_type", "status", "crm_system", "crm_account_ref", "mail_thread_refs", "invoice_number", "subtotal_cents"]);
    for (const e of events) for (const k of Object.keys(e.payload)) assert.ok(allowed.has(k), `unexpected integration field ${k}`);
    assert.ok(!JSON.stringify(events).includes("Example General Hospital"), "places do not leave TMS");
  } finally { w.close(); }
});

test("documents are private: no paths or public URLs, short audited links, restricted download and review", async () => {
  const w = world();
  try {
    const c = await makeCase(w);
    const made = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents`, { request_key: randomUUID(), category: "RELEASE_AUTHORIZATION", file_name: `${DECEDENT} release.pdf`, content_type: "application/pdf", size_bytes: 2048 });
    assert.equal(made.status, 201); assert.equal(made.headers.get("cache-control"), "no-store");
    assert.equal(made.body.document.path, undefined); assert.equal(made.body.upload.expires_in_seconds, 7200);
    const row = w.db.tables.mortuary_documents[0];
    assert.match(String(row.path), new RegExp(`^${A}/${c.id}/[0-9a-f-]{36}\\.pdf$`)); assert.ok(!String(row.path).includes("Jordan"), "paths never carry names");
    assert.equal((await w.call("platform", "POST", `/mortuary/cases/${c.id}/documents`, { request_key: randomUUID(), category: "OTHER", file_name: "x.pdf", content_type: "application/pdf", size_bytes: 1 })).status, 403);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents`, { request_key: randomUUID(), category: "OTHER", file_name: "x.exe", content_type: "application/x-msdownload", size_bytes: 1 })).status, 400);
    const up = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/uploaded`, { expected_version: 1 });
    assert.equal(up.body.code, "UPLOAD_NOT_FOUND");
    w.present.add(String(row.path));
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/uploaded`, { expected_version: 1 })).body.document.status, "RECEIVED");
    const list = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/documents`);
    assert.equal(list.body.documents[0].status, "RECEIVED"); assert.ok(!/path|url|storage\.example/.test(JSON.stringify(list.body.documents)), "metadata only");
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/download-url`, {})).body.code, "RESTRICTED_ACCESS_REQUIRED");
    assert.equal((await w.call("platform", "POST", `/mortuary/cases/${c.id}/documents/${row.id}/download-url`, {})).status, 403);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/review`, { expected_version: 2, decision: "APPROVED" })).status, 403);
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/review`, { expected_version: 2, decision: "REJECTED" })).status, 400, "a rejection needs a note");
    const link = await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/download-url`, {});
    assert.equal(link.status, 200); assert.equal(link.body.expires_in_seconds, 120); assert.equal(link.headers.get("cache-control"), "no-store");
    assert.deepEqual(w.signedFor.at(-1), { path: row.path, seconds: 120 });
    assert.ok(w.db.tables.mortuary_access_log.some((l) => l.action === "DOCUMENT_DOWNLOAD_URL" && l.target_id === row.id));
    const approved = await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/review`, { expected_version: 2, decision: "APPROVED" });
    assert.equal(approved.body.document.status, "APPROVED");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/documents/${row.id}/review`, { expected_version: 3, decision: "REJECTED", note: "x" })).status, 409, "review decisions are not overwritten");
    const cl = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/checklist`);
    assert.deepEqual(cl.body.items.map((i: Row) => [i.category, i.state]), [["RELEASE_AUTHORIZATION", "APPROVED"], ["TRANSIT_PERMIT", "MISSING"]]);
    assert.equal(cl.body.complete, false); assert.match(cl.body.notice, /not a statement of legal requirements/);
  } finally { w.close(); }
});

test("invalid transitions are refused with every unmet condition", async () => {
  const w = world();
  try {
    const c = await makeCase(w);
    const jump = await transition(w, c.id, "IN_TRANSIT");
    assert.equal(jump.status, 409); assert.equal(jump.body.code, "INVALID_TRANSITION");
    assert.equal((await transition(w, c.id, "ON_HOLD")).body.problems[0], "Give a reason");
    assert.equal((await transition(w, c.id, "AWAITING_RELEASE")).status, 200);
    const ready = await transition(w, c.id, "READY_FOR_DISPATCH");
    assert.deepEqual(ready.body.problems, ["Document not approved: RELEASE_AUTHORIZATION", "Document not approved: TRANSIT_PERMIT"]);
    assert.equal((await transition(w, c.id, "ON_HOLD", "Waiting on family")).body.case.held_from_status, "AWAITING_RELEASE");
    assert.deepEqual((await transition(w, c.id, "INTAKE")).body.problems, ["Resume the case to AWAITING_RELEASE"]);
    assert.equal((await transition(w, c.id, "AWAITING_RELEASE")).body.case.held_from_status, null);
    // Custody: a transfer needs a verified identity check; a tag mismatch is a discrepancy, never a pass.
    const transfer = { releasing_party: { kind: "RELEASING_FACILITY", name: "Casey Fixture", organization: "Example General Hospital" }, receiving_party: { kind: "TRANSPORT_STAFF", name: "Riley Driver", driver_id: D.d1 }, location: place("Example General Hospital"), releasing_acknowledgment: ack("Casey Fixture"), receiving_acknowledgment: ack("Riley Driver") };
    const t1 = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("TRANSFER", transfer, 0));
    assert.equal(t1.body.code, "INVALID_TRANSITION"); assert.deepEqual(t1.body.problems, ["Record a verified identity check before this transfer"]);
    await w.call(M.ownerA, "PUT", `/mortuary/cases/${c.id}/restricted`, { expected_version: 0, decedent_full_name: DECEDENT, id_tag_number: TAG });
    const mismatch = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("IDENTITY_CHECK", { method: "TAG", outcome: "VERIFIED", observed_tag: "TAG-WRONG" }, 0));
    assert.equal(mismatch.body.event.payload.outcome, "DISCREPANCY"); assert.equal(mismatch.body.event.payload.tag_check, "MISMATCH");
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("TRANSFER", transfer, 1))).body.code, "INVALID_TRANSITION");
    // Cancel is refused while company staff hold custody.
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("IDENTITY_CHECK", { method: "TAG", outcome: "VERIFIED", observed_tag: TAG }, 1));
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("TRANSFER", transfer, 2))).status, 201);
    assert.deepEqual((await transition(w, c.id, "CANCELED", "Family changed plans")).body.problems, ["Company transport staff hold custody; release custody before canceling"]);
    // Releasing party must be the current custodian.
    const wrong = { ...transfer, releasing_party: { kind: "FUNERAL_HOME", name: "Someone" }, receiving_party: { kind: "FUNERAL_HOME", name: "Someone else" } };
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("IDENTITY_CHECK", { method: "PAPERWORK", outcome: "VERIFIED" }, 3));
    assert.deepEqual((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("TRANSFER", wrong, 4))).body.problems, ["The releasing party must be the current custodian (TRANSPORT_STAFF)"]);
    // A leg cannot start while the case is not ready, nor take custody without a transfer on that leg.
    const leg = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("O"), to: place("D", "FUNERAL_HOME"), scheduled_departure_at: "2026-10-22T13:00:00.000Z", scheduled_arrival_at: "2026-10-22T15:00:00.000Z" })).body.leg;
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/assignment`, { expected_version: 1, driver_id: D.d1, vehicle_id: V.v1 });
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/status`, { to: "EN_ROUTE", expected_version: 2 })).body.code, "INVALID_TRANSITION");
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/status`, { to: "DELIVERED", expected_version: 2 })).body.code, "INVALID_TRANSITION");
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("O"), to: place("D"), scheduled_departure_at: "2026-10-22T13:00:00.000Z", scheduled_arrival_at: "2026-10-26T13:00:00.000Z" })).status, 400, "windows longer than 72h");
  } finally { w.close(); }
});

test("a domestic case runs end to end with an attributable, hash-chained custody log", async () => {
  const w = world();
  try {
    const c = await makeCase(w);
    await w.call(M.ownerA, "PUT", `/mortuary/cases/${c.id}/restricted`, { expected_version: 0, decedent_full_name: DECEDENT, id_tag_number: TAG });
    await transition(w, c.id, "AWAITING_RELEASE");
    await approvedDoc(w, c.id, "RELEASE_AUTHORIZATION");
    await approvedDoc(w, c.id, "TRANSIT_PERMIT");
    assert.equal((await transition(w, c.id, "READY_FOR_DISPATCH")).status, 200);
    const leg = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("Example General Hospital"), to: place("Example Family Funeral Home", "FUNERAL_HOME"), scheduled_departure_at: "2026-10-22T13:00:00.000Z", scheduled_arrival_at: "2026-10-22T15:00:00.000Z" })).body.leg;
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/assignment`, { expected_version: 1, driver_id: D.d1, vehicle_id: V.v1 })).body.leg.status, "ASSIGNED");

    // Assignment conflicts: the same driver and vehicle cannot overlap on another case.
    const other = await makeCase(w);
    const otherLeg = (await w.call(M.dispA, "POST", `/mortuary/cases/${other.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("A"), to: place("B"), scheduled_departure_at: "2026-10-22T14:00:00.000Z", scheduled_arrival_at: "2026-10-22T16:00:00.000Z" })).body.leg;
    const clash = await w.call(M.dispA, "POST", `/mortuary/cases/${other.id}/legs/${otherLeg.id}/assignment`, { expected_version: 1, driver_id: D.d1, vehicle_id: V.v1 });
    assert.equal(clash.body.code, "ASSIGNMENT_CONFLICT"); assert.equal(clash.body.problems.length, 2); assert.match(clash.body.problems[0], /^Driver is already on .* leg 1/);
    w.db.tables.drivers.find((d) => d.id === D.d2)!.status = "ON_TRIP";
    assert.deepEqual((await w.call(M.dispA, "POST", `/mortuary/cases/${other.id}/legs/${otherLeg.id}/assignment`, { expected_version: 1, driver_id: D.d2, vehicle_id: V.v2, dry_run: true })).body, { ok: false, problems: ["Driver is on a freight trip"] });

    // The driver sees only their leg, with no contacts or decedent data, and works it.
    const mine = await w.call(M.driverA, "GET", "/driver/mortuary/legs");
    assert.equal(mine.body.legs.length, 1); assert.ok(!/Alex Sample|authorized_contacts|Jordan|TAG-/.test(mine.raw));
    assert.equal((await w.call(M.driver2A, "GET", `/driver/mortuary/legs/${leg.id}/custody-events`)).status, 404, "another driver's leg");
    assert.equal((await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/status`, { to: "EN_ROUTE", expected_version: 2 })).body.leg.status, "EN_ROUTE");
    assert.equal((await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/custody-events`, custody("CORRECTION", { corrects_seq: 1, reason: "x", changes: { occurred_at: NOW } }, 0))).status, 403, "drivers cannot correct");
    await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/custody-events`, custody("IDENTITY_CHECK", { method: "TAG", outcome: "VERIFIED", observed_tag: TAG }, 0));
    const pickup = { releasing_party: { kind: "RELEASING_FACILITY", name: "Casey Fixture", organization: "Example General Hospital" }, receiving_party: { kind: "TRANSPORT_STAFF", name: "Riley Drivr", driver_id: D.d1 }, location: place("Example General Hospital"), releasing_acknowledgment: { method: "PAPER_FORM", reference: "REL-FORM-0001", acknowledged_at: "2026-10-22T11:54:00.000Z" }, receiving_acknowledgment: ack("Riley Driver") };
    const driverPage = await w.call(M.driverA, "GET", `/driver/mortuary/legs/${leg.id}/custody-events`);
    assert.equal(driverPage.body.last_seq, 1, "driver can safely append at the current case sequence");
    assert.equal(driverPage.body.current_custodian, undefined, "driver receives no case-wide custodian detail");
    const took = await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/custody-events`, custody("TRANSFER", pickup, 1));
    assert.equal(took.status, 201, took.raw); assert.equal(took.body.current_custodian.kind, "TRANSPORT_STAFF");
    assert.equal(took.body.event.recorded_by.role, "DRIVER");
    assert.equal((await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/status`, { to: "IN_CUSTODY", expected_version: 3 })).body.leg.status, "IN_CUSTODY");
    assert.equal((await transition(w, c.id, "IN_TRANSIT")).status, 200);
    await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/custody-events`, custody("IDENTITY_CHECK", { method: "TAG", outcome: "VERIFIED", observed_tag: TAG }, 2));
    const dropoff = { releasing_party: { kind: "TRANSPORT_STAFF", name: "Riley Driver", driver_id: D.d1 }, receiving_party: { kind: "FUNERAL_HOME", name: "Alex Sample", organization: "Example Family Funeral Home" }, location: place("Example Family Funeral Home", "FUNERAL_HOME"), releasing_acknowledgment: ack("Riley Driver"), receiving_acknowledgment: ack("Alex Sample") };
    assert.equal((await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/custody-events`, custody("TRANSFER", dropoff, 3))).status, 201);
    assert.equal((await w.call(M.driverA, "POST", `/driver/mortuary/legs/${leg.id}/status`, { to: "DELIVERED", expected_version: 4 })).body.leg.status, "DELIVERED");
    assert.equal((await transition(w, c.id, "DELIVERED")).status, 200);

    // An incident blocks closing until resolved.
    const inc = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("INCIDENT", { severity: "LOW", category: "DELAY", description: "Traffic delay of 40 minutes" }, 4));
    assert.deepEqual((await transition(w, c.id, "CLOSED")).body.problems, ["1 custody incident(s) are unresolved"]);
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("INCIDENT_RESOLVED", { incident_key: inc.body.event.payload.incident_key, resolution: "Receiving home informed" }, 5));

    // A correction is a new, attributed event; the original stays as recorded.
    const fix = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CORRECTION", { corrects_seq: 2, reason: "Typo in driver name", changes: { payload: { receiving_party: { kind: "TRANSPORT_STAFF", name: "Riley Driver", driver_id: D.d1 } } } }, 6));
    assert.equal(fix.status, 201, fix.raw); assert.equal(fix.body.event.recorded_by.member_id, M.dispA);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CORRECTION", { corrects_seq: 2, reason: "x", changes: { payload: { incident_key: randomUUID() } } }, 7))).status, 400, "server-set fields cannot be corrected");
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CORRECTION", { corrects_seq: 7, reason: "x", changes: { occurred_at: NOW } }, 7))).status, 400, "corrections cannot be corrected");
    const log = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/custody-events`);
    assert.equal(log.body.events.find((e: Row) => e.seq === 2).payload.receiving_party.name, "Riley Drivr", "original unchanged");
    assert.equal(log.body.effective.find((e: Row) => e.seq === 2).payload.receiving_party.name, "Riley Driver");
    assert.deepEqual(log.body.effective.find((e: Row) => e.seq === 2).corrected_by, [7]);
    assert.equal(log.body.effective.some((e: Row) => e.kind === "CORRECTION"), false);
    assert.equal(log.body.chain_valid, true); assert.equal(log.body.current_custodian.kind, "FUNERAL_HOME");
    assert.equal((await transition(w, c.id, "CLOSED")).status, 200);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CHECKPOINT", { type: "OTHER" }, 7))).status, 409, "closed cases take no more events");
    const history = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/history`);
    assert.deepEqual(history.body.history.map((h: Row) => h.to_status), ["AWAITING_RELEASE", "READY_FOR_DISPATCH", "IN_TRANSIT", "DELIVERED", "CLOSED"]);
    // Tampering with a stored event breaks the chain.
    (w.db.tables.mortuary_custody_events[1].payload as Row).note = "edited outside the API";
    assert.equal((await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/custody-events`)).body.chain_valid, false);
    assert.equal((await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/custody-events?after_seq=3`)).body.chain_valid, null);
  } finally { w.close(); }
});

test("duplicate submissions replay instead of creating twins; a reused key with a different body is refused", async () => {
  const w = world();
  try {
    const body = newCase();
    const first = await w.call(M.dispA, "POST", "/mortuary/cases", body);
    const again = await w.call(M.dispA, "POST", "/mortuary/cases", body);
    assert.equal(first.status, 201); assert.equal(again.status, 200); assert.equal(again.body.replayed, true); assert.equal(again.body.case.id, first.body.case.id);
    assert.equal((await w.call(M.dispA, "POST", "/mortuary/cases", { ...body, service_type: "FIRST_CALL_REMOVAL" })).body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(w.db.tables.mortuary_cases.length, 1);
    assert.equal((await w.call(M.dispA, "POST", "/mortuary/cases", newCase({ case_number: first.body.case.case_number }))).body.code, "CONFLICT", "case numbers are unique per company");
    const c = first.body.case;
    const t = { request_key: randomUUID(), to: "AWAITING_RELEASE", expected_version: 1 };
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/transitions`, t)).status, 200);
    const replay = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/transitions`, t);
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.case.version, 2);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/transitions`, { ...t, to: "CANCELED", reason: "x" })).body.code, "IDEMPOTENCY_KEY_REUSED");
    const ev = custody("CHECKPOINT", { type: "ARRIVED", note: "fixture" }, 0);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, ev)).status, 201);
    const evAgain = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, ev);
    assert.equal(evAgain.status, 200); assert.equal(evAgain.body.replayed, true); assert.equal(w.db.tables.mortuary_custody_events.length, 1);
    const doc = { request_key: randomUUID(), category: "OTHER", file_name: "a.pdf", content_type: "application/pdf", size_bytes: 10 };
    const d1 = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents`, doc), d2 = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/documents`, doc);
    assert.equal(d2.body.document.id, d1.body.document.id); assert.ok(d2.body.upload.signed_url, "a fresh upload link while still pending"); assert.equal(w.db.tables.mortuary_documents.length, 1);
  } finally { w.close(); }
});

test("concurrent updates: one writer wins, the other gets a conflict with the current state", async () => {
  const w = world();
  try {
    const body = newCase();
    const twins = await Promise.all([w.call(M.dispA, "POST", "/mortuary/cases", body), w.call(M.dispA, "POST", "/mortuary/cases", body)]);
    assert.deepEqual(twins.map((r) => r.status).sort(), [200, 201]); assert.equal(w.db.tables.mortuary_cases.length, 1);
    const c = twins[0].body.case;
    const moves = await Promise.all([
      w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/transitions`, { request_key: randomUUID(), to: "AWAITING_RELEASE", expected_version: 1 }),
      w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/transitions`, { request_key: randomUUID(), to: "ON_HOLD", expected_version: 1, reason: "Hold" }),
    ]);
    assert.deepEqual(moves.map((r) => r.status).sort(), [200, 409]);
    const lost = moves.find((r) => r.status === 409)!;
    assert.equal(lost.body.code, "VERSION_CONFLICT"); assert.equal(lost.body.current.version, 2);
    assert.equal(w.db.tables.mortuary_case_status_events.length, 1);
    // Two people append custody events at the same position: one lands at seq 1, the other must reload.
    const race = await Promise.all([
      w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CHECKPOINT", { type: "ARRIVED" }, 0)),
      w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CHECKPOINT", { type: "DEPARTED" }, 0)),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    assert.equal(race.find((r) => r.status === 409)!.body.code, "SEQUENCE_CONFLICT");
    assert.deepEqual(w.db.tables.mortuary_custody_events.map((e) => e.seq), [1]);
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("CHECKPOINT", { type: "OTHER" }, 0))).body.current.last_seq, 1, "stale expected_seq");
    // Two dispatchers assign the same leg at once.
    const leg = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("O"), to: place("D"), scheduled_departure_at: "2026-10-22T13:00:00.000Z", scheduled_arrival_at: "2026-10-22T15:00:00.000Z" })).body.leg;
    const assigns = await Promise.all([
      w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/assignment`, { expected_version: 1, driver_id: D.d1, vehicle_id: V.v1 }),
      w.call(M.disp2A, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/assignment`, { expected_version: 1, driver_id: D.d2, vehicle_id: V.v2 }),
    ]);
    assert.deepEqual(assigns.map((r) => r.status).sort(), [200, 409]); assert.equal(assigns.find((r) => r.status === 409)!.body.code, "VERSION_CONFLICT");
    // Concurrent leg creation on one case still yields distinct sequence numbers.
    const legs = await Promise.all([1, 2, 3].map(() => w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "AIR", from: place("ATL", "AIRPORT_CARGO"), to: place("KIN", "AIRPORT_CARGO", "JM"), scheduled_departure_at: "2026-10-23T13:00:00.000Z", scheduled_arrival_at: "2026-10-23T18:00:00.000Z" })));
    assert.ok(legs.every((r) => r.status === 201)); assert.deepEqual(legs.map((r) => r.body.leg.seq).sort(), [2, 3, 4]);
  } finally { w.close(); }
});

test("international: requirements carry sources, staff approval is gated and never legal clearance", async () => {
  const w = world();
  try {
    const c = await makeCase(w, M.dispA, { service_type: "INTERNATIONAL_OUTBOUND", destination: place("Example Receiving Funeral Services", "FUNERAL_HOME", "JM") });
    const base = `/mortuary/cases/${c.id}/international`;
    assert.equal((await w.call(M.dispA, "POST", `${base}/requirements`, { request_key: randomUUID(), country: "JM", jurisdiction_role: "DESTINATION", authority: "x", description: "y", source_type: "AGENT_ADVICE", source_reference: "ref", reviewed_on: "2026-10-01" })).body.error, "Create the international record first");
    assert.equal((await w.call(M.dispA, "PUT", base, { expected_version: 0, origin_country: "US", destination_country: "US" })).status, 400);
    assert.equal((await w.call(M.dispA, "PUT", base, { expected_version: 0, origin_country: "US", destination_country: "JM", transit_countries: ["PA"] })).status, 200);
    const reqBody = { request_key: randomUUID(), country: "JM", jurisdiction_role: "DESTINATION", authority: "Fixture consulate", description: "Consular seal on documents", document_category: "CONSULAR_DOCUMENT", source_type: "CONSULATE_CORRESPONDENCE", reviewed_on: "2026-10-15" };
    assert.equal((await w.call(M.dispA, "POST", `${base}/requirements`, reqBody)).status, 400, "a requirement needs its source");
    const req = await w.call(M.dispA, "POST", `${base}/requirements`, { ...reqBody, source_reference: "Consulate letter REF-FIXTURE-12" });
    assert.equal(req.status, 201); assert.equal(req.body.requirement.stale, false);
    assert.equal((await w.call(M.dispA, "POST", `${base}/requirements`, { ...reqBody, request_key: randomUUID(), country: "FR", source_reference: "x-ref" })).status, 400, "country must be on the route");
    const old = await w.call(M.dispA, "POST", `${base}/requirements`, { ...reqBody, request_key: randomUUID(), country: "PA", jurisdiction_role: "TRANSIT", authority: "Fixture transit authority", document_category: null, source_reference: "https://example.test/transit-rules", reviewed_on: "2026-06-01" });
    assert.equal(old.body.requirement.stale, true);
    const cl = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/checklist`);
    assert.deepEqual(cl.body.items.find((i: Row) => i.category === "CONSULAR_DOCUMENT").sources, ["REQUIREMENT"]);
    const view = await w.call(M.dispA, "GET", base);
    assert.equal(view.body.legal_clearance, false); assert.equal(view.body.readiness.ready, false);
    const approve = (v: number, acknowledge = RELEASE_ACKNOWLEDGEMENT) => w.call(M.ownerA, "POST", `${base}/release-approval`, { expected_version: v, acknowledge, note: "Fixture" });
    assert.equal((await w.call(M.dispA, "POST", `${base}/release-approval`, { expected_version: 1, acknowledge: RELEASE_ACKNOWLEDGEMENT })).status, 403);
    assert.equal((await approve(1, "ok")).status, 400);
    const blocked = await approve(1);
    assert.equal(blocked.body.code, "NOT_READY");
    for (const p of ["Add the receiving funeral home or agent", "Requirement still open: Fixture consulate", "Requirement review older than 90 days: Fixture transit authority", "Document not approved: CONSULAR_DOCUMENT"]) assert.ok(blocked.body.problems.includes(p), p);
    // Satisfy everything.
    let rec = (await w.call(M.dispA, "PUT", base, { expected_version: 1, origin_country: "US", destination_country: "JM", transit_countries: ["PA"], receiving_party: { name: "Morgan Agent", organization: "Example Receiving Funeral Services", role: "FUNERAL_HOME", country: "JM" }, carrier: { name: "Fixture Air Cargo", iata_code: "FX" } })).body.record;
    await w.call(M.dispA, "PATCH", `${base}/requirements/${req.body.requirement.id}`, { expected_version: 1, status: "SATISFIED" });
    assert.equal((await w.call(M.dispA, "PATCH", `${base}/requirements/${old.body.requirement.id}`, { expected_version: 1, status: "NOT_APPLICABLE" })).status, 400, "not applicable needs a note");
    await w.call(M.dispA, "PATCH", `${base}/requirements/${old.body.requirement.id}`, { expected_version: 1, reviewed_on: "2026-10-20", status: "SATISFIED" });
    for (const cat of ["RELEASE_AUTHORIZATION", "DEATH_CERTIFICATE", "TRANSIT_PERMIT", "AIRWAY_BILL", "CONSULAR_DOCUMENT"]) await approvedDoc(w, c.id, cat);
    await transition(w, c.id, "AWAITING_RELEASE");
    assert.deepEqual((await transition(w, c.id, "READY_FOR_DISPATCH")).body.problems, ["International release approval has not been recorded"]);
    const ok = await approve(rec.version);
    assert.equal(ok.status, 200, ok.raw); assert.equal(ok.body.legal_clearance, false); assert.equal(ok.body.record.release_status, "APPROVED");
    assert.equal(ok.body.record.release_snapshot.requirements.length, 2);
    assert.equal((await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}`)).body.case.status, "AWAITING_RELEASE", "approval does not move the case");
    assert.equal((await transition(w, c.id, "READY_FOR_DISPATCH")).status, 200);
    // Milestones are append-only; a correction supersedes.
    const m1 = await w.call(M.dispA, "POST", `${base}/milestones`, { request_key: randomUUID(), kind: "CARRIER_BOOKED", occurred_at: "2026-10-22T10:00:00.000Z", reference: "AWB 000-FIXTURE" });
    assert.equal(m1.status, 201);
    assert.equal((await w.call(M.dispA, "POST", `${base}/milestones`, { request_key: randomUUID(), kind: "CARRIER_BOOKED", occurred_at: "2026-10-22T10:05:00.000Z", reference: "AWB 000-FIXTURE-2", supersedes_id: m1.body.milestone.id })).body.milestone.supersedes_id, m1.body.milestone.id);
    // Changing the route withdraws approval.
    rec = (await w.call(M.dispA, "GET", base)).body.record;
    const moved = await w.call(M.dispA, "PUT", base, { expected_version: rec.version, origin_country: "US", destination_country: "JM", transit_countries: [], receiving_party: rec.receiving_party, carrier: rec.carrier });
    assert.equal(moved.body.record.release_status, "REVOKED");
    // Domestic cases have no international record.
    const dom = await makeCase(w);
    assert.equal((await w.call(M.dispA, "GET", `/mortuary/cases/${dom.id}/international`)).body.code, "CONFLICT");
  } finally { w.close(); }
});

test("billing keeps quoted, invoiced and provider-verified payment states distinct", async () => {
  const w = world();
  try {
    const c = await makeCase(w, M.dispA, { crm_system: "RELAY", crm_account_ref: "relay-acct-fixture" });
    const lines = [{ category: "SERVICE", code: "TRANSFER", description: "Local transfer", quantity: 1, unit_cents: 45000 }, { category: "MILEAGE", description: "Mileage", quantity: 42.5, unit_cents: 350, amount_cents: 1 }];
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/quotes`, { request_key: randomUUID(), lines: [{ ...lines[1], quantity: 42.55 }], valid_until: "2026-11-01" })).status, 400, "miles take one decimal");
    assert.equal((await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/quotes`, { request_key: randomUUID(), lines, valid_until: "2026-10-01" })).status, 400, "expired on creation");
    const q = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/quotes`, { request_key: randomUUID(), lines, valid_until: "2026-11-01" })).body.quote;
    assert.equal(q.status, "DRAFT"); assert.equal(q.subtotal_cents, 45000 + 14875); assert.equal(q.lines[1].amount_cents, 14875, "amounts are server-computed");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/quotes/${q.id}/accept`, { expected_version: 1, acceptance_reference: "Mail thread fixture" })).body.code, "INVALID_TRANSITION");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices`, { request_key: randomUUID(), quote_id: q.id, due_date: "2026-11-15" })).body.code, "INVALID_TRANSITION");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/quotes/${q.id}/issue`, { expected_version: 1 })).body.quote.status, "ISSUED");
    const q2 = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/quotes`, { request_key: randomUUID(), lines: [lines[0]], valid_until: "2026-11-01" })).body.quote;
    await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/quotes/${q2.id}/issue`, { expected_version: 1 });
    const billing = await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/billing`);
    assert.deepEqual(billing.body.quotes.map((x: Row) => [x.number, x.status]), [["Q1", "SUPERSEDED"], ["Q2", "ISSUED"]]);
    const accepted = await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/quotes/${q2.id}/accept`, { expected_version: 2, acceptance_reference: "Mail thread fixture" });
    assert.equal(accepted.body.quote.status, "ACCEPTED");
    const inv = { request_key: randomUUID(), quote_id: q2.id, additional_lines: [{ category: "ADDITIONAL", description: "After-hours call", quantity: 1, unit_cents: 7500 }], due_date: "2026-11-15" };
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices`, { ...inv, request_key: randomUUID(), additional_lines: [{ ...inv.additional_lines[0], category: "SERVICE" }] })).status, 400);
    const issued = await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices`, inv);
    assert.equal(issued.status, 201); assert.equal(issued.body.invoice.status, "ISSUED"); assert.equal(issued.body.invoice.subtotal_cents, 52500);
    assert.equal(issued.body.invoice.payment.status, "NOT_VERIFIED", "issuing is not payment");
    assert.match(issued.body.invoice.invoice_number, /^MI-2026-[A-Z0-9]{6}$/);
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices`, inv)).body.replayed, true);
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices`, { ...inv, request_key: randomUUID() })).body.code, "CONFLICT", "one open invoice per quote");
    // Nothing records payment: no route, no column.
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices/${issued.body.invoice.id}/payment`, { status: "PROVIDER_VERIFIED_PAID" })).status, 404);
    assert.equal("payment_status" in w.db.tables.mortuary_invoices[0], false);
    const events = (await w.call(M.dispA, "GET", `/mortuary/cases/${c.id}/integration-events`)).body.events;
    const invEvent = events.find((e: Row) => e.kind === "invoice.issued");
    assert.equal(invEvent.target, "CRM"); assert.equal(invEvent.status, "PENDING", "no consumer delivers events yet");
    assert.equal((await w.call(M.ownerA, "POST", `/mortuary/cases/${c.id}/invoices/${issued.body.invoice.id}/void`, { expected_version: 1, reason: "Fixture void" })).body.invoice.status, "VOID");
  } finally { w.close(); }
});

test("gates, pagination and validation", async () => {
  const w = world({ mortuaryB: false });
  try {
    assert.equal((await w.call(M.ownerB, "POST", "/mortuary/cases", newCase())).body.code, "MODULE_DISABLED");
    // Onboarding incomplete blocks assignment, not intake.
    const p = w.db.tables.transport_profiles.find((x) => x.id === A)!;
    p.mortuary_setup = { ...SETUP, checks: ["coverage"] };
    const c = await makeCase(w);
    const leg = (await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs`, { request_key: randomUUID(), mode: "GROUND", from: place("O"), to: place("D"), scheduled_departure_at: "2026-10-22T13:00:00.000Z", scheduled_arrival_at: "2026-10-22T15:00:00.000Z" })).body.leg;
    const gated = await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/legs/${leg.id}/assignment`, { expected_version: 1, driver_id: D.d1, vehicle_id: V.v1 });
    assert.equal(gated.body.code, "ONBOARDING_INCOMPLETE"); assert.equal(gated.body.problems.length, 5);
    p.mortuary_setup = SETUP;
    // Validation keeps the existing shape and adds a code.
    const bad = await w.call(M.dispA, "POST", "/mortuary/cases", { ...newCase(), origin: { ...place("x"), country: "USA" }, surprise: true });
    assert.equal(bad.status, 400); assert.equal(bad.body.code, "VALIDATION_FAILED"); assert.ok(Array.isArray(bad.body.issues));
    assert.equal((await w.call(M.dispA, "POST", "/mortuary/cases", newCase({ coordinator_member_id: M.driverA }))).status, 400, "drivers cannot coordinate");
    // Cursor pagination: stable, no duplicates, no gaps.
    for (let i = 0; i < 6; i++) await makeCase(w);
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const r: { body: { cases: Row[]; next_cursor: string | null } } = await w.call(M.dispA, "GET", `/mortuary/cases?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.cases.map((x) => x.id)); cursor = r.body.next_cursor; pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3); assert.equal(seen.length, 7); assert.equal(new Set(seen).size, 7);
    assert.equal((await w.call(M.dispA, "GET", "/mortuary/cases?cursor=bm9wZQ")).status, 400);
    assert.equal((await w.call(M.dispA, "GET", "/mortuary/cases?status=INTAKE&status=CLOSED")).body.cases.length, 7);
    // Board windows are bounded.
    assert.equal((await w.call(M.dispA, "GET", "/mortuary/dispatch/board?from=2026-10-01T00:00:00.000Z&to=2026-10-30T00:00:00.000Z")).status, 400);
    assert.equal((await w.call(M.dispA, "GET", "/mortuary/dispatch/board?from=2026-10-22T00:00:00.000Z&to=2026-10-23T00:00:00.000Z")).body.legs[0].case_number, c.case_number);
  } finally { w.close(); }
});

test("nothing about a case is written to the server log", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of ["log", "error", "warn", "info"] as const) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const w = world();
  try {
    const c = await makeCase(w);
    await w.call(M.ownerA, "PUT", `/mortuary/cases/${c.id}/restricted`, { expected_version: 0, decedent_full_name: DECEDENT, id_tag_number: TAG });
    await w.call(M.ownerA, "PUT", `/mortuary/cases/${c.id}/restricted`, { expected_version: 0, decedent_full_name: DECEDENT, date_of_death: "2030-01-01" });
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, custody("IDENTITY_CHECK", { method: "TAG", outcome: "VERIFIED", observed_tag: "WRONG" }, 0));
    await w.call(M.dispA, "POST", `/mortuary/cases/${c.id}/custody-events`, { garbage: DECEDENT });
  } finally {
    w.close();
    Object.assign(console, orig);
  }
  assert.ok(!lines.some((l) => l.includes(DECEDENT) || l.includes(TAG)), lines.join("\n"));
});
