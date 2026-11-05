import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson, caseTransitionProblems, checklist, currentCustodian, effectiveEvents, identityVerifiedSinceLastTransfer, integrationPayload, integrationTargets,
  openIncidents, overlaps, priceLines, releaseProblems, requirementStale, tagCheck, transferProblems, type CaseFacts, type CustodyEvent,
} from "./index.js";

const facts = (o: Partial<CaseFacts> = {}): CaseFacts => ({
  status: "AWAITING_RELEASE", held_from_status: null, international: false, onboarding_gaps: [], checklist_incomplete: [], release_status: null, custodian: null, open_legs: 0, open_incidents: 0, ...o,
});
const ev = (seq: number, kind: CustodyEvent["kind"], payload: Record<string, unknown>, leg_id: string | null = null): CustodyEvent => ({ seq, kind, leg_id, occurred_at: `2026-10-22T10:0${seq}:00.000Z`, payload });

test("case transitions list every unmet guard", () => {
  assert.deepEqual(caseTransitionProblems(facts(), "READY_FOR_DISPATCH"), []);
  assert.deepEqual(caseTransitionProblems(facts({ international: true, checklist_incomplete: ["AIRWAY_BILL"], onboarding_gaps: ["Coverage"] }), "READY_FOR_DISPATCH"), [
    "Onboarding: Coverage", "Document not approved: AIRWAY_BILL", "International release approval has not been recorded",
  ]);
  assert.deepEqual(caseTransitionProblems(facts({ status: "INTAKE" }), "DELIVERED"), ["A case cannot go from INTAKE to DELIVERED"]);
  assert.deepEqual(caseTransitionProblems(facts({ status: "CLOSED" }), "INTAKE"), ["A case cannot go from CLOSED to INTAKE"]);
  assert.deepEqual(caseTransitionProblems(facts({ status: "READY_FOR_DISPATCH" }), "AWAITING_RELEASE"), ["Give a reason"]);
  assert.deepEqual(caseTransitionProblems(facts({ status: "IN_TRANSIT", custodian: "TRANSPORT_STAFF", open_legs: 1 }), "DELIVERED"), ["Record the custody transfer to the receiving party first", "1 leg(s) are not delivered or canceled"]);
  assert.deepEqual(caseTransitionProblems(facts({ status: "ON_HOLD", held_from_status: "IN_TRANSIT", custodian: "TRANSPORT_STAFF" }), "CANCELED", "x"), ["Company transport staff hold custody; release custody before canceling"]);
  assert.deepEqual(caseTransitionProblems(facts({ status: "DELIVERED", open_incidents: 2 }), "CLOSED"), ["2 custody incident(s) are unresolved"]);
});

test("corrections apply in order without touching the originals", () => {
  const log = [
    ev(1, "IDENTITY_CHECK", { outcome: "VERIFIED" }),
    ev(2, "TRANSFER", { releasing_party: { kind: "RELEASING_FACILITY", name: "A" }, receiving_party: { kind: "TRANSPORT_STAFF", name: "Rily" } }),
    ev(3, "CORRECTION", { corrects_seq: 2, reason: "typo", changes: { payload: { receiving_party: { kind: "TRANSPORT_STAFF", name: "Riley" } } } }),
    ev(4, "INCIDENT", { incident_key: "k1", description: "d" }),
    ev(5, "CORRECTION", { corrects_seq: 4, reason: "x", changes: { occurred_at: "2026-10-22T09:00:00.000Z", payload: { incident_key: "forged", description: "better" } } }),
  ];
  const before = JSON.stringify(log);
  const eff = effectiveEvents(log);
  assert.equal(JSON.stringify(log), before, "input untouched");
  assert.deepEqual(eff.map((e) => e.seq), [1, 2, 4]);
  assert.equal(currentCustodian(eff)?.name, "Riley");
  assert.deepEqual(eff[1].corrected_by, [3]);
  assert.equal(eff[2].payload.incident_key, "k1", "incident keys cannot be corrected");
  assert.equal(eff[2].occurred_at, "2026-10-22T09:00:00.000Z");
  assert.equal(openIncidents(eff).length, 1);
  assert.equal(openIncidents(effectiveEvents([...log, ev(6, "INCIDENT_RESOLVED", { incident_key: "k1", resolution: "r" })])).length, 0);
});

test("a transfer needs a fresh verified identity check and the current custodian releasing", () => {
  const verified = ev(1, "IDENTITY_CHECK", { outcome: "VERIFIED" });
  const take = ev(2, "TRANSFER", { releasing_party: { kind: "RELEASING_FACILITY", name: "A" }, receiving_party: { kind: "TRANSPORT_STAFF", name: "R" } });
  assert.equal(identityVerifiedSinceLastTransfer(effectiveEvents([verified])), true);
  assert.equal(identityVerifiedSinceLastTransfer(effectiveEvents([verified, take])), false, "each transfer needs its own check");
  assert.equal(identityVerifiedSinceLastTransfer(effectiveEvents([verified, ev(2, "IDENTITY_CHECK", { outcome: "DISCREPANCY" })])), false, "the latest check counts");
  const after = effectiveEvents([verified, take, ev(3, "IDENTITY_CHECK", { outcome: "VERIFIED" })]);
  assert.deepEqual(transferProblems(after, { kind: "TRANSPORT_STAFF", name: "R" }), []);
  assert.deepEqual(transferProblems(after, { kind: "FUNERAL_HOME", name: "F" }), ["The releasing party must be the current custodian (TRANSPORT_STAFF)"]);
});

test("tag checks normalise case and spacing and never need the observed value afterwards", () => {
  assert.equal(tagCheck("TAG-12 34", "tag-1234"), "MATCH");
  assert.equal(tagCheck("TAG-1234", "TAG-1235"), "MISMATCH");
  assert.equal(tagCheck(null, "TAG"), "NOT_ON_FILE");
  assert.equal(tagCheck("TAG", "  "), "NOT_PROVIDED");
});

test("checklist merges service defaults, staff additions and requirements, and reports the best document state", () => {
  const items = checklist("DOMESTIC_TRANSFER", ["CUSTODY_ACKNOWLEDGMENT", "TRANSIT_PERMIT"], ["TRANSIT_PERMIT"], [
    { id: "1", category: "RELEASE_AUTHORIZATION", status: "REJECTED" }, { id: "2", category: "RELEASE_AUTHORIZATION", status: "APPROVED" }, { id: "3", category: "TRANSIT_PERMIT", status: "RECEIVED" },
  ]);
  assert.deepEqual(items.map((i) => [i.category, i.state, i.sources.join("+")]), [
    ["RELEASE_AUTHORIZATION", "APPROVED", "SERVICE_TYPE"], ["TRANSIT_PERMIT", "AWAITING_REVIEW", "SERVICE_TYPE+CASE+REQUIREMENT"], ["CUSTODY_ACKNOWLEDGMENT", "MISSING", "CASE"],
  ]);
});

test("release readiness: stale and open requirements, missing receiver and documents all block", () => {
  assert.equal(requirementStale("2026-07-24", "2026-10-22"), false);
  assert.equal(requirementStale("2026-07-23", "2026-10-22"), true);
  const p = releaseProblems({ onboarding_gaps: [], record: {}, requirements: [{ id: "r", authority: "Consulate", status: "SATISFIED", reviewed_on: "2026-01-01" }], checklist: [], open_incidents: 0, today: "2026-10-22" });
  assert.deepEqual(p, ["Add the receiving funeral home or agent", "Requirement review older than 90 days: Consulate"]);
  assert.deepEqual(releaseProblems({ onboarding_gaps: [], record: null, requirements: [], checklist: [], open_incidents: 0, today: "2026-10-22" }), ["Create the international record first"]);
});

test("charges: server-computed amounts, positive values, bounded totals", () => {
  const r = priceLines([{ category: "MILEAGE", description: "m", quantity: 42.5, unit_cents: 350 }, { category: "SERVICE", description: "s", quantity: 1, unit_cents: 45000 }]);
  assert.deepEqual([r.lines[0].amount_cents, r.subtotal_cents], [14875, 59875]);
  assert.throws(() => priceLines([{ category: "SERVICE", description: "s", quantity: 1, unit_cents: 0 }]));
  assert.throws(() => priceLines([{ category: "SERVICE", description: "s", quantity: 2, unit_cents: 99_999_999 }]), /too large/);
});

test("integration payloads come from an allow-list and Signal is never a target", () => {
  const c = { id: "c", case_number: "MC-1", service_type: "DOMESTIC_TRANSFER", status: "INTAKE", crm_system: "RELAY", crm_account_ref: "acct", mail_thread_refs: ["t"], decedent_full_name: "Never", origin: { name: "Never" } };
  assert.deepEqual(integrationPayload(c, "CRM"), { case_id: "c", case_number: "MC-1", service_type: "DOMESTIC_TRANSFER", status: "INTAKE", crm_system: "RELAY", crm_account_ref: "acct" });
  assert.deepEqual(Object.keys(integrationPayload(c, "MAIL")).sort(), ["case_id", "case_number", "mail_thread_refs", "service_type", "status"]);
  assert.deepEqual(integrationTargets(c, "case.opened"), ["CRM", "MAIL"]);
  assert.deepEqual(integrationTargets(c, "invoice.issued"), ["CRM"]);
  assert.deepEqual(integrationTargets({ crm_account_ref: null, mail_thread_refs: [] }, "case.opened"), []);
});

test("canonical JSON is key-order independent and windows overlap only when they intersect", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: null }], c: undefined } }), canonicalJson({ a: { d: [1, { x: null, y: 2 }] }, b: 1 }));
  assert.equal(overlaps({ start: "2026-10-22T13:00:00Z", end: "2026-10-22T15:00:00Z" }, { start: "2026-10-22T15:00:00Z", end: "2026-10-22T16:00:00Z" }), false, "back-to-back is fine");
  assert.equal(overlaps({ start: "2026-10-22T13:00:00Z", end: "2026-10-22T15:00:00Z" }, { start: "2026-10-22T14:59:00Z", end: "2026-10-22T16:00:00Z" }), true);
});
