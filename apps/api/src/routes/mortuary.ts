// TMS–Mortuary: cases, restricted records, dispatch, chain of custody,
// documents, quotes/invoices and international coordination.
// The contract is docs/mortuary-api-contract.md (v1.0.0). Keep them in step.
//
// Privacy rules this file keeps:
//  - decedent details live only in mortuary_case_restricted and are returned
//    only to people with restricted access, never to machines or drivers;
//  - nothing here logs request bodies, and errors never echo restricted values;
//  - documents use their own private bucket and short signed links, and are
//    never copied to a connected Google Drive;
//  - other systems get only allow-listed references (core integrationPayload).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  canonicalJson, caseTransitionProblems, checklist, CHECKLIST_NOTICE, CASE_FINISHED, CASE_STATUSES, CHARGE_CATEGORIES, currentCustodian,
  CUSTODY_KINDS, DOCUMENT_CATEGORIES, effectiveEvents, FACILITY_TYPES, identityVerifiedSinceLastTransfer, integrationPayload, integrationTargets,
  isInternational, LEG_ACTIVE, LEG_CUSTODIANS, LEG_MODES, LEG_TRANSITIONS, MAX_LEG_WINDOW_HOURS, mortuaryGaps, openIncidents, overlaps, PARTY_KINDS,
  priceLines, RELEASE_ACKNOWLEDGEMENT, releaseProblems, requirementStale, SERVICE_TYPES, tagCheck, transferProblems,
  type CaseStatus, type MortuaryChargeLine, type CustodyEvent, type LegMode, type MortuaryLegStatus, type ServiceType,
} from "@onixus/core";
import { StoreError, type Row, type Store } from "@onixus/providers";
import { currentCaller } from "../auth.js";
import { HttpError, today, uuid, type Ctx, type Member } from "../http.js";

// ── Errors ───────────────────────────────────────────────────────────────────
const fail = (status: number, code: string, message: string, problems?: string[], current?: Record<string, unknown>) => new HttpError(status, message, problems, code, current);
const missing = (what: string) => fail(404, "NOT_FOUND", `${what} not found`);
const forbidden = (message = "Your role cannot do this") => fail(403, "FORBIDDEN", message);
const versionConflict = (row: Row | null) => fail(409, "VERSION_CONFLICT", "This record changed; reload and try again", undefined, row ? { version: row.version, ...(row.status !== undefined ? { status: row.status } : {}) } : undefined);
const badRequest = (message: string) => fail(400, "BAD_REQUEST", message);
const isConflict = (e: unknown) => e instanceof StoreError && e.status === 409;

// ── Validation ───────────────────────────────────────────────────────────────
const str = (max: number) => z.string().trim().min(1).max(max);
const opt = (max: number) => z.string().trim().min(1).max(max).nullish();
const country = z.string().regex(/^[A-Z]{2}$/, "Use a two-letter ISO country code");
const instant = z.string().datetime({ message: "Use an ISO 8601 UTC timestamp ending in Z" });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Not a real date");
const version = z.number().int().min(1);
const unique = <T>(v: T[]) => [...new Set(v)];

const place = z.object({ name: str(200), facility_type: z.enum(FACILITY_TYPES), address_line: opt(300), city: opt(120), region: opt(120), postal_code: opt(20), country }).strict();
const requestingOrg = z.object({ name: str(200), type: z.enum(["FUNERAL_HOME", "HOSPITAL", "HOSPICE", "MEDICAL_EXAMINER", "FAMILY", "AGENT", "OTHER"]), phone: opt(40), email: z.string().trim().toLowerCase().email().nullish() }).strict();
const contact = z.object({
  name: str(200), relationship: z.enum(["NEXT_OF_KIN", "LEGAL_REPRESENTATIVE", "FUNERAL_DIRECTOR", "FACILITY_STAFF", "AGENT", "OTHER"]),
  phone: opt(40), email: z.string().trim().toLowerCase().email().nullish(), may_authorize_release: z.boolean(), crm_contact_ref: opt(200),
}).strict();
const caseFields = {
  requesting_organization: requestingOrg,
  crm_system: z.enum(["RELAY", "HUBSPOT", "OTHER"]).nullish(),
  crm_account_ref: opt(200),
  authorized_contacts: z.array(contact).max(10),
  origin: place,
  destination: place,
  coordinator_member_id: uuid.nullish(),
  required_document_categories: z.array(z.enum(DOCUMENT_CATEGORIES)).max(DOCUMENT_CATEGORIES.length).transform(unique),
  mail_thread_refs: z.array(str(200)).max(20).transform(unique),
};
const caseCreate = z.object({
  request_key: uuid, case_number: z.string().regex(/^[A-Za-z0-9-]{3,40}$/, "Letters, digits and dashes, 3–40 characters").optional(), service_type: z.enum(SERVICE_TYPES),
  ...caseFields, authorized_contacts: caseFields.authorized_contacts.default([]), required_document_categories: caseFields.required_document_categories.default([]), mail_thread_refs: caseFields.mail_thread_refs.default([]),
}).strict();
const casePatch = z.object({
  expected_version: version, service_type: z.enum(SERVICE_TYPES).optional(),
  requesting_organization: requestingOrg.optional(), crm_system: caseFields.crm_system, crm_account_ref: caseFields.crm_account_ref,
  authorized_contacts: caseFields.authorized_contacts.optional(), origin: place.optional(), destination: place.optional(), coordinator_member_id: caseFields.coordinator_member_id,
  required_document_categories: caseFields.required_document_categories.optional(), mail_thread_refs: caseFields.mail_thread_refs.optional(),
}).strict();
const transition = z.object({ request_key: uuid, to: z.enum(CASE_STATUSES), expected_version: version, reason: z.string().trim().max(500).nullish() }).strict();
const restricted = z.object({
  expected_version: z.number().int().min(0), decedent_full_name: str(200), date_of_birth: day.nullish(), date_of_death: day.nullish(), place_of_death: opt(300),
  id_tag_number: opt(80), handling_notes: opt(2000), precautions: opt(1000), personal_effects: opt(2000), religious_or_cultural_considerations: opt(1000),
}).strict();

const carrier = z.object({ name: str(200), flight_number: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/, "Use an airline code and flight number").nullish(), airway_bill: opt(40), partner_reference: opt(200) }).strict();
const legCreate = z.object({ request_key: uuid, mode: z.enum(LEG_MODES), from: place, to: place, scheduled_departure_at: instant, scheduled_arrival_at: instant, carrier: carrier.nullish() }).strict();
const legPatch = z.object({ expected_version: version, from: place.optional(), to: place.optional(), scheduled_departure_at: instant.optional(), scheduled_arrival_at: instant.optional(), carrier: carrier.nullish() }).strict();
const assignment = z.object({ expected_version: version, driver_id: uuid.optional(), vehicle_id: uuid.optional(), carrier: carrier.optional(), dry_run: z.boolean().default(false) }).strict();
const legStatus = z.object({ to: z.enum(["EN_ROUTE", "IN_CUSTODY", "DELIVERED", "CANCELED"]), expected_version: version, occurred_at: instant.optional(), reason: z.string().trim().max(500).nullish() }).strict();

const party = z.object({ kind: z.enum(PARTY_KINDS), name: str(200), organization: opt(200), title: opt(120), driver_id: uuid.nullish() }).strict();
const ack = z.object({
  method: z.enum(["SIGNATURE_DOCUMENT", "TYPED_NAME", "PAPER_FORM", "VERBAL_CONFIRMED_BY_STAFF"]), document_id: uuid.nullish(), typed_name: opt(200), reference: opt(200), acknowledged_at: instant,
}).strict().superRefine((a, c) => {
  if (a.method === "SIGNATURE_DOCUMENT" && !a.document_id) c.addIssue({ code: "custom", path: ["document_id"], message: "A signature document needs document_id" });
  if (a.method === "TYPED_NAME" && !a.typed_name) c.addIssue({ code: "custom", path: ["typed_name"], message: "Typed acknowledgment needs typed_name" });
  if (a.method === "PAPER_FORM" && !a.reference) c.addIssue({ code: "custom", path: ["reference"], message: "Paper form needs its reference" });
});
const note = z.string().trim().max(1000).nullish();
const PAYLOADS = {
  IDENTITY_CHECK: z.object({ method: z.enum(["TAG", "WRISTBAND", "PAPERWORK", "FACILITY_STAFF_CONFIRMATION"]), outcome: z.enum(["VERIFIED", "DISCREPANCY", "UNABLE"]), observed_tag: z.string().trim().max(80).nullish(), note }).strict(),
  TRANSFER: z.object({ releasing_party: party, receiving_party: party, location: place, releasing_acknowledgment: ack, receiving_acknowledgment: ack, note }).strict(),
  CHECKPOINT: z.object({ type: z.enum(["ARRIVED", "DEPARTED", "LOADED", "UNLOADED", "STORAGE_IN", "STORAGE_OUT", "OTHER"]), location: place.nullish(), note }).strict(),
  INCIDENT: z.object({ severity: z.enum(["LOW", "MEDIUM", "HIGH"]), category: z.enum(["DELAY", "ID_DISCREPANCY", "DOCUMENT_ISSUE", "VEHICLE", "DAMAGE", "HANDLING", "OTHER"]), description: str(2000) }).strict(),
  INCIDENT_RESOLVED: z.object({ incident_key: uuid, resolution: str(2000) }).strict(),
  CORRECTION: z.object({ corrects_seq: z.number().int().min(1), reason: str(1000), changes: z.object({ occurred_at: instant.optional(), payload: z.record(z.unknown()).optional() }).strict() }).strict(),
} as const;
/** What a correction may change, per corrected kind. Server-set fields (tag_check, incident_key) are never correctable. */
const CORRECTABLE = {
  IDENTITY_CHECK: PAYLOADS.IDENTITY_CHECK.omit({ observed_tag: true }).partial().strict(),
  TRANSFER: PAYLOADS.TRANSFER.partial().strict(),
  CHECKPOINT: PAYLOADS.CHECKPOINT.partial().strict(),
  INCIDENT: PAYLOADS.INCIDENT.partial().strict(),
  INCIDENT_RESOLVED: PAYLOADS.INCIDENT_RESOLVED.omit({ incident_key: true }).partial().strict(),
} as const;
const custodyBody = z.object({ request_key: uuid, expected_seq: z.number().int().min(0), kind: z.enum(CUSTODY_KINDS), leg_id: uuid.nullish(), occurred_at: instant, payload: z.record(z.unknown()) }).strict();

const CONTENT_TYPES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const docCreate = z.object({ request_key: uuid, category: z.enum(DOCUMENT_CATEGORIES), file_name: str(200), content_type: z.enum(Object.keys(CONTENT_TYPES) as [string, ...string[]]), size_bytes: z.number().int().min(1).max(26_214_400) }).strict();
const review = z.object({ expected_version: version, decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().trim().max(1000).nullish() }).strict();

const line = z.object({
  category: z.enum(CHARGE_CATEGORIES), code: opt(40), description: str(200), quantity: z.number().positive().max(100_000), unit_cents: z.number().int().min(1).max(99_999_999), amount_cents: z.number().optional(),
}).strict().refine((l) => l.category !== "MILEAGE" || Math.abs(l.quantity * 10 - Math.round(l.quantity * 10)) < 1e-9, { message: "Miles take at most one decimal", path: ["quantity"] });
const quoteCreate = z.object({ request_key: uuid, lines: z.array(line).min(1).max(50), valid_until: day, notes: z.string().trim().max(1000).nullish() }).strict();
const quotePatch = z.object({ expected_version: version, lines: z.array(line).min(1).max(50).optional(), valid_until: day.optional(), notes: z.string().trim().max(1000).nullish() }).strict();
const invoiceCreate = z.object({ request_key: uuid, quote_id: uuid, additional_lines: z.array(line).max(20).default([]), due_date: day }).strict();

const intlPut = z.object({
  expected_version: z.number().int().min(0), origin_country: country, destination_country: country, transit_countries: z.array(country).max(5).default([]),
  receiving_party: z.object({ name: str(200), organization: str(200), role: z.enum(["FUNERAL_HOME", "AGENT", "FAMILY_REPRESENTATIVE", "OTHER"]), phone: opt(40), email: z.string().trim().toLowerCase().email().nullish(), country, crm_contact_ref: opt(200) }).strict().nullish(),
  carrier: z.object({ name: str(200), iata_code: z.string().regex(/^[A-Z0-9]{2}$/).nullish(), booking_reference: opt(60) }).strict().nullish(),
}).strict();
const SOURCE_TYPES = ["OFFICIAL_PUBLICATION", "CONSULATE_CORRESPONDENCE", "CARRIER_POLICY", "AGENT_ADVICE", "INTERNAL_PROCEDURE"] as const;
const requirementCreate = z.object({
  request_key: uuid, country, jurisdiction_role: z.enum(["ORIGIN", "DESTINATION", "TRANSIT", "CARRIER"]), authority: str(200), description: str(1000),
  document_category: z.enum(DOCUMENT_CATEGORIES).nullish(), source_type: z.enum(SOURCE_TYPES), source_reference: z.string().trim().min(3).max(1000), reviewed_on: day,
}).strict();
const requirementPatch = z.object({ expected_version: version, status: z.enum(["OPEN", "SATISFIED", "NOT_APPLICABLE"]).optional(), status_note: z.string().trim().max(1000).nullish(), source_reference: z.string().trim().min(3).max(1000).optional(), reviewed_on: day.optional() }).strict();
const milestoneCreate = z.object({
  request_key: uuid, kind: z.enum(["DOCUMENTS_SUBMITTED", "CONSULAR_DOCUMENT_RECEIVED", "CARRIER_BOOKED", "TENDERED_TO_CARRIER", "DEPARTED", "TRANSIT_STOP", "ARRIVED", "CUSTOMS_PROCESSED", "RELEASED_TO_RECEIVING_PARTY", "OTHER"]),
  occurred_at: instant, reference: opt(200), location_country: country.nullish(), note: z.string().trim().max(1000).nullish(), supersedes_id: uuid.nullish(),
}).strict();

// ── Small helpers ────────────────────────────────────────────────────────────
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const requestHash = (body: unknown) => sha256(canonicalJson(body));
const iso = (v: unknown) => new Date(String(v)).toISOString();
const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = (n: number) => [...randomBytes(n)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
const ALL = { limit: 10_000 };

type Actor = { kind: "USER"; user_id: string; member_id: string; role: string } | { kind: "PLATFORM" };
type Case = Row & { org_id: string; case_number: string; service_type: ServiceType; status: CaseStatus; held_from_status: CaseStatus | null; version: number; coordinator_member_id: string | null; crm_account_ref: string | null; crm_system: string | null; mail_thread_refs: string[]; required_document_categories: string[]; has_restricted_record: boolean };
type Leg = Row & { case_id: string; seq: number; mode: LegMode; status: MortuaryLegStatus; version: number; driver_id: string | null; vehicle_id: string | null; scheduled_departure_at: string; scheduled_arrival_at: string; carrier: Record<string, unknown> | null };
type Stored = Row & { seq: number; kind: CustodyEvent["kind"]; leg_id: string | null; occurred_at: string; recorded_at: string; recorded_by: unknown; payload: Record<string, any>; prev_hash: string | null; hash: string; case_id: string; request_hash: string };

export function mortuaryRoutes(ctx: Ctx) {
  const r = Router();
  const store = () => ctx.store();
  const now = () => ctx.now();
  const todayStr = () => today(ctx);

  // ── Who is calling ─────────────────────────────────────────────────────────
  r.use((_req: Request, res: Response, next: NextFunction) => {
    const c = currentCaller();
    const deny = (status: number, code: string, error: string) => res.status(status).json({ error, code });
    if (!c) return deny(401, "UNAUTHENTICATED", "Sign in first");
    if (c.kind === "system") {
      if (c.keyId) return deny(403, "FORBIDDEN", "Company keys cannot reach mortuary cases");
      return c.orgId ? next() : deny(400, "BAD_REQUEST", "Send X-Org-Id to act inside an organization");
    }
    if (!c.member) return deny(403, "FORBIDDEN", "Join or create a company first");
    if (c.member.role === "DRIVER") return deny(403, "FORBIDDEN", "Drivers use the driver app");
    next();
  });

  const caller = () => currentCaller()!;
  const person = (): Member => {
    const c = caller();
    if (c.kind !== "user" || !c.member) throw forbidden("A signed-in person must do this");
    return c.member;
  };
  const owner = () => {
    const m = person();
    if (m.role !== "OWNER") throw forbidden("Only an owner can do this");
    return m;
  };
  const actor = (): Actor => {
    const c = caller();
    return c.kind === "user" && c.member ? { kind: "USER", user_id: c.user.id, member_id: c.member.id, role: c.member.role } : { kind: "PLATFORM" };
  };
  const actorId = () => {
    const a = actor();
    return a.kind === "USER" ? a.user_id : "platform";
  };
  const org = () => {
    const c = caller();
    return (c.kind === "system" ? c.orgId : c.member?.org_id)!;
  };

  // ── Module and onboarding gates (existing owner checklist) ────────────────
  async function profile() {
    const p = await store().get("transport_profiles", org());
    if (!(p?.modules as string[] | undefined)?.includes("MORTUARY")) throw fail(409, "MODULE_DISABLED", "Enable mortuary transport in Business setup first");
    return p!;
  }
  const gaps = (p: Row | null) => mortuaryGaps(p?.mortuary_setup as never);
  async function onboarded() {
    const g = gaps(await profile());
    if (g.length) throw fail(409, "ONBOARDING_INCOMPLETE", "Finish the owner-reviewed mortuary onboarding checklist first", g);
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  async function getRow<T extends Row>(table: string, id: string, what: string): Promise<T> {
    const row = await store().get<T>(table, uuid.parse(id));
    if (!row) throw missing(what);
    return row;
  }
  const getCase = (id: string) => getRow<Case>("mortuary_cases", id, "Case");
  async function child<T extends Row>(table: string, c: Case, id: string, what: string): Promise<T> {
    const row = await getRow<T>(table, id, what);
    if (row.case_id !== c.id) throw missing(what);
    return row;
  }
  async function writable(c: Case, allowDelivered = false) {
    if (c.status === "CLOSED" || c.status === "CANCELED" || (!allowDelivered && c.status === "DELIVERED")) throw fail(409, "CONFLICT", `The case is ${c.status}`);
  }

  async function custodyOf(caseId: string) {
    const rows = await store().list<Stored>("mortuary_custody_events", { case_id: caseId }, ALL);
    return rows.sort((a, b) => a.seq - b.seq);
  }

  // ── Restricted access ──────────────────────────────────────────────────────
  async function grantedCases(memberId: string) {
    return new Set((await store().list("mortuary_case_access", { member_id: memberId, revoked_at: null }, ALL)).map((g) => String(g.case_id)));
  }
  async function canSeeRestricted(c: Case) {
    const k = caller();
    if (k.kind !== "user" || !k.member) return false;
    if (k.member.role === "OWNER" || c.coordinator_member_id === k.member.id) return true;
    return (await grantedCases(k.member.id)).has(c.id);
  }
  async function needRestricted(c: Case) {
    if (caller().kind !== "user") throw forbidden("Restricted case data needs a signed-in person");
    if (!(await canSeeRestricted(c))) throw fail(403, "RESTRICTED_ACCESS_REQUIRED", "You need restricted access to this case");
  }
  const audit = (caseId: string, action: string, targetId?: string | null) => store().insert("mortuary_access_log", { case_id: caseId, actor: actor(), action, target_id: targetId ?? null });

  // ── Idempotent create ──────────────────────────────────────────────────────
  /** Insert once per request_key. Same key + same body replays; a different body is refused. */
  async function once<T extends Row>(table: string, body: { request_key: string }, insert: (hash: string) => Promise<T>): Promise<{ row: T; replayed: boolean }> {
    const hash = requestHash(body);
    const prior = async () => {
      const [p] = await store().list<T>(table, { request_key: body.request_key }, { limit: 1 });
      if (p && p.request_hash !== hash) throw fail(409, "IDEMPOTENCY_KEY_REUSED", "This request_key was already used for a different request");
      return p ?? null;
    };
    const seen = await prior();
    if (seen) return { row: seen, replayed: true };
    try {
      return { row: await insert(hash), replayed: false };
    } catch (e) {
      // A twin request may have won the race on the unique key.
      if (isConflict(e)) {
        const p = await prior();
        if (p) return { row: p, replayed: true };
      }
      throw e;
    }
  }
  /** Retry an insert that picks a number (case number, sequence) when the number was just taken. */
  async function numbered<T>(attempt: () => Promise<T>, tries = 4): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await attempt();
      } catch (e) {
        if (!isConflict(e) || i >= tries) throw e;
      }
    }
  }
  /** Compare-and-set on version; 409 with the current state when someone else got there first. */
  async function bump<T extends Row>(table: string, row: Row, expected: number, patch: Record<string, unknown>, expect: Record<string, string | number | null> = {}): Promise<T> {
    if (row.version !== expected) throw versionConflict(row);
    const updated = await store().update<T>(table, row.id, { ...patch, version: expected + 1 }, { version: expected, ...expect });
    if (!updated) throw versionConflict(await store().get(table, row.id));
    return updated;
  }

  // ── Views (explicit field lists so new columns never leak) ─────────────────
  const caseView = (c: Case, restrictedAccess: boolean) => ({
    id: c.id, case_number: c.case_number, service_type: c.service_type, international: isInternational(c.service_type),
    requesting_organization: c.requesting_organization, crm_system: c.crm_system ?? null, crm_account_ref: c.crm_account_ref ?? null,
    authorized_contacts: c.authorized_contacts ?? [], origin: c.origin, destination: c.destination, coordinator_member_id: c.coordinator_member_id ?? null,
    required_document_categories: c.required_document_categories ?? [], mail_thread_refs: c.mail_thread_refs ?? [], status: c.status, held_from_status: c.held_from_status ?? null,
    version: c.version, has_restricted_record: !!c.has_restricted_record, restricted_access: restrictedAccess, created_by: c.created_by ?? null, created_at: c.created_at, updated_at: c.updated_at ?? c.created_at,
  });
  const legView = (l: Leg) => ({
    id: l.id, case_id: l.case_id, seq: l.seq, mode: l.mode, from: l.from_place, to: l.to_place, scheduled_departure_at: l.scheduled_departure_at, scheduled_arrival_at: l.scheduled_arrival_at,
    driver_id: l.driver_id ?? null, vehicle_id: l.vehicle_id ?? null, carrier: l.carrier ?? null, status: l.status, assigned_at: l.assigned_at ?? null, actual_departure_at: l.actual_departure_at ?? null,
    actual_pickup_at: l.actual_pickup_at ?? null, actual_delivery_at: l.actual_delivery_at ?? null, canceled_at: l.canceled_at ?? null, cancel_reason: l.cancel_reason ?? null, version: l.version,
  });
  const eventView = (e: Stored) => ({ id: e.id, case_id: e.case_id, seq: e.seq, kind: e.kind, leg_id: e.leg_id ?? null, occurred_at: e.occurred_at, recorded_at: e.recorded_at, recorded_by: e.recorded_by, payload: e.payload, prev_hash: e.prev_hash ?? null, hash: e.hash });
  const docView = (d: Row) => ({
    id: d.id, case_id: d.case_id, category: d.category, status: d.status, file_name: d.file_name, content_type: d.content_type, size_bytes: d.size_bytes, uploaded_by: d.uploaded_by ?? null,
    uploaded_at: d.uploaded_at ?? null, reviewed_by: d.reviewed_by ?? null, reviewed_at: d.reviewed_at ?? null, review_note: d.review_note ?? null, version: d.version, created_at: d.created_at,
  });
  const quoteView = (q: Row) => ({
    id: q.id, case_id: q.case_id, number: q.number, status: q.status, lines: q.lines, subtotal_cents: Number(q.subtotal_cents), currency: q.currency ?? "USD", valid_until: q.valid_until, notes: q.notes ?? null,
    issued_at: q.issued_at ?? null, accepted_at: q.accepted_at ?? null, acceptance_reference: q.acceptance_reference ?? null, decline_reason: q.decline_reason ?? null, version: q.version, created_at: q.created_at,
  });
  const invoiceView = (i: Row) => ({
    id: i.id, case_id: i.case_id, invoice_number: i.invoice_number, quote_id: i.quote_id, status: i.status, lines: i.lines, subtotal_cents: Number(i.subtotal_cents), currency: i.currency ?? "USD",
    due_date: i.due_date, issued_at: i.issued_at, voided_at: i.voided_at ?? null, void_reason: i.void_reason ?? null, version: i.version,
    payment: { status: "NOT_VERIFIED", provider: null, verified_at: null, notice: "No payment provider is connected to mortuary invoices. Payment is not recorded here." },
  });
  const requirementView = (q: Row) => ({
    id: q.id, case_id: q.case_id, country: q.country, jurisdiction_role: q.jurisdiction_role, authority: q.authority, description: q.description, document_category: q.document_category ?? null,
    source_type: q.source_type, source_reference: q.source_reference, reviewed_on: q.reviewed_on, reviewed_by: q.reviewed_by ?? null, status: q.status, status_note: q.status_note ?? null,
    stale: q.status !== "NOT_APPLICABLE" && requirementStale(String(q.reviewed_on), todayStr()), version: q.version,
  });
  const intlView = (i: Row | null) => i && ({
    case_id: i.id, origin_country: i.origin_country, destination_country: i.destination_country, transit_countries: i.transit_countries ?? [], receiving_party: i.receiving_party ?? null, carrier: i.carrier ?? null,
    release_status: i.release_status, release_approved_by: i.release_approved_by ?? null, release_approved_at: i.release_approved_at ?? null, release_note: i.release_note ?? null, release_snapshot: i.release_snapshot ?? null, version: i.version,
  });

  // ── Case facts (for guards and summaries) ──────────────────────────────────
  async function facts(c: Case) {
    const [events, legs, docs, reqs, intl, p] = await Promise.all([
      custodyOf(c.id),
      store().list<Leg>("mortuary_transport_legs", { case_id: c.id }, ALL),
      store().list("mortuary_documents", { case_id: c.id }, ALL),
      store().list("mortuary_requirements", { case_id: c.id }, ALL),
      store().get("mortuary_international", c.id),
      store().get("transport_profiles", org()),
    ]);
    const effective = effectiveEvents(events);
    const reqCategories = reqs.filter((q) => q.status !== "NOT_APPLICABLE" && q.document_category).map((q) => String(q.document_category));
    const items = checklist(c.service_type, c.required_document_categories ?? [], reqCategories, docs.map((d) => ({ id: d.id, category: String(d.category), status: String(d.status) })));
    return { events, effective, legs, docs, reqs, intl, profile: p, items, custodian: currentCustodian(effective), incidents: openIncidents(effective) };
  }

  async function enqueue(c: Case, kind: "case.opened" | "case.status_changed" | "invoice.issued", extra: { invoice_number?: string; subtotal_cents?: number } = {}) {
    for (const target of integrationTargets(c, kind)) {
      await store().insert("mortuary_integration_events", { case_id: c.id, target, kind, payload: integrationPayload(c, target, extra), status: "PENDING" });
    }
  }

  async function checkCoordinator(id: string | null | undefined) {
    if (!id) return;
    const m = await store().get("memberships", id);
    if (!m || m.disabled_at || !["OWNER", "DISPATCHER"].includes(String(m.role))) throw badRequest("The coordinator must be an active owner or dispatcher of this company");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Cases
  // ════════════════════════════════════════════════════════════════════════════
  r.post("/cases", async (req, res) => {
    const body = caseCreate.parse(req.body);
    await profile();
    await checkCoordinator(body.coordinator_member_id);
    const created = await once<Case>("mortuary_cases", body, (hash) =>
      numbered(async () => {
        const id = randomUUID(), at = now().toISOString();
        const number = body.case_number ?? `MC-${at.slice(2, 10).replace(/-/g, "")}-${code(4)}`;
        if (body.case_number) {
          const [taken] = await store().list("mortuary_cases", { case_number: number }, { limit: 1 });
          if (taken) throw fail(409, "CONFLICT", "That case number is already used in this company");
        }
        const { request_key, case_number: _n, ...fields } = body;
        return store().insert<Case>("mortuary_cases", {
          id, request_key, request_hash: hash, case_number: number, ...fields, crm_system: fields.crm_system ?? null, crm_account_ref: fields.crm_account_ref ?? null,
          coordinator_member_id: fields.coordinator_member_id ?? null, status: "INTAKE", held_from_status: null, has_restricted_record: false, version: 1,
          sort_key: `${at}~${id}`, created_by: actorId(), updated_at: at,
        });
      }, body.case_number ? 1 : 4),
    ).catch((e) => {
      // A supplied case number taken by a different request at the same moment.
      throw isConflict(e) ? fail(409, "CONFLICT", "That case number is already used in this company") : e;
    });
    if (!created.replayed) await enqueue(created.row, "case.opened");
    res.status(created.replayed ? 200 : 201).json({ case: caseView(created.row, await canSeeRestricted(created.row)), ...(created.replayed ? { replayed: true } : {}) });
  });

  r.get("/cases", async (req, res) => {
    const q = z.object({
      status: z.union([z.enum(CASE_STATUSES), z.array(z.enum(CASE_STATUSES)).max(CASE_STATUSES.length)]).optional(),
      service_type: z.enum(SERVICE_TYPES).optional(), coordinator_member_id: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(400).optional(),
    }).strict().parse(req.query);
    let after: string | undefined;
    if (q.cursor) {
      after = Buffer.from(q.cursor, "base64url").toString("utf8");
      if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z~[0-9a-f-]{36}$/.test(after)) throw badRequest("That cursor is not valid");
    }
    const where: Record<string, string | string[]> = {};
    if (q.status) where.status = Array.isArray(q.status) ? q.status : [q.status];
    if (q.service_type) where.service_type = q.service_type;
    if (q.coordinator_member_id) where.coordinator_member_id = q.coordinator_member_id;
    const rows = await store().list<Case>("mortuary_cases", where, { order: "sort_key", ascending: false, limit: q.limit + 1, after });
    const page = rows.slice(0, q.limit);
    const k = caller();
    const granted = k.kind === "user" && k.member ? await grantedCases(k.member.id) : new Set<string>();
    const access = (c: Case) => k.kind === "user" && !!k.member && (k.member.role === "OWNER" || c.coordinator_member_id === k.member.id || granted.has(c.id));
    res.json({ cases: page.map((c) => caseView(c, access(c))), next_cursor: rows.length > q.limit ? Buffer.from(String(page.at(-1)!.sort_key)).toString("base64url") : null });
  });

  r.get("/cases/:id", async (req, res) => {
    const c = await getCase(req.params.id);
    const f = await facts(c);
    const missingDocs = f.items.filter((i) => i.state === "MISSING" || i.state === "PENDING_UPLOAD" || i.state === "REJECTED").map((i) => i.category);
    res.json({
      case: caseView(c, await canSeeRestricted(c)),
      summary: {
        current_custodian: f.custodian,
        open_incidents: f.incidents.length,
        legs: { total: f.legs.length, delivered: f.legs.filter((l) => l.status === "DELIVERED").length, canceled: f.legs.filter((l) => l.status === "CANCELED").length },
        checklist: { required: f.items.length, approved: f.items.filter((i) => i.state === "APPROVED").length, missing: missingDocs, awaiting_review: f.items.filter((i) => i.state === "AWAITING_REVIEW").map((i) => i.category) },
        international: isInternational(c.service_type)
          ? { release_status: f.intl?.release_status ?? "NOT_REQUESTED", stale_requirements: f.reqs.filter((q) => q.status !== "NOT_APPLICABLE" && requirementStale(String(q.reviewed_on), todayStr())).length, open_requirements: f.reqs.filter((q) => q.status === "OPEN").length }
          : null,
      },
    });
  });

  r.patch("/cases/:id", async (req, res) => {
    const body = casePatch.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    await writable(c);
    if (body.service_type && body.service_type !== c.service_type) {
      if (c.status !== "INTAKE") throw fail(409, "CONFLICT", "The service type can change only during intake");
      if (!isInternational(body.service_type) && (await store().get("mortuary_international", c.id))) throw fail(409, "CONFLICT", "This case has an international record; keep it international");
    }
    if (body.coordinator_member_id !== undefined) await checkCoordinator(body.coordinator_member_id);
    const { expected_version, ...fields } = body;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const updated = await bump<Case>("mortuary_cases", c, expected_version, { ...patch, updated_at: now().toISOString() });
    res.json({ case: caseView(updated, await canSeeRestricted(updated)) });
  });

  r.post("/cases/:id/transitions", async (req, res) => {
    const body = transition.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    const hash = requestHash(body);
    const [prior] = await store().list("mortuary_case_status_events", { request_key: body.request_key }, { limit: 1 });
    if (prior) {
      if (prior.request_hash !== hash) throw fail(409, "IDEMPOTENCY_KEY_REUSED", "This request_key was already used for a different request");
      return void res.json({ case: caseView(c, await canSeeRestricted(c)), replayed: true });
    }
    if (c.version !== body.expected_version) throw versionConflict(c);
    const f = await facts(c);
    const problems = caseTransitionProblems({
      status: c.status, held_from_status: c.held_from_status ?? null, international: isInternational(c.service_type), onboarding_gaps: gaps(f.profile),
      checklist_incomplete: f.items.filter((i) => i.state !== "APPROVED").map((i) => i.category), release_status: (f.intl?.release_status as string) ?? null,
      custodian: f.custodian?.kind ?? null, open_legs: f.legs.filter((l) => l.status !== "DELIVERED" && l.status !== "CANCELED").length, open_incidents: f.incidents.length,
    }, body.to, body.reason);
    if (problems.length) throw fail(409, "INVALID_TRANSITION", `The case cannot move to ${body.to}`, problems);
    const updated = await bump<Case>("mortuary_cases", c, body.expected_version, {
      status: body.to, held_from_status: body.to === "ON_HOLD" ? c.status : null, last_transition_key: body.request_key, updated_at: now().toISOString(),
    }, { status: c.status });
    await store().insert("mortuary_case_status_events", { case_id: c.id, request_key: body.request_key, request_hash: hash, from_status: c.status, to_status: body.to, reason: body.reason ?? null, actor: actor() });
    await enqueue(updated, "case.status_changed");
    res.json({ case: caseView(updated, await canSeeRestricted(updated)), replayed: false });
  });

  r.get("/cases/:id/history", async (req, res) => {
    const c = await getCase(req.params.id);
    const rows = await store().list("mortuary_case_status_events", { case_id: c.id }, { ...ALL, order: "created_at", ascending: true });
    res.json({ history: rows.map((h) => ({ id: h.id, from_status: h.from_status, to_status: h.to_status, reason: h.reason ?? null, actor: h.actor, created_at: h.created_at })) });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Restricted record and access grants
  // ════════════════════════════════════════════════════════════════════════════
  const restrictedView = (x: Row) => ({
    case_id: x.id, decedent_full_name: x.decedent_full_name, date_of_birth: x.date_of_birth ?? null, date_of_death: x.date_of_death ?? null, place_of_death: x.place_of_death ?? null,
    id_tag_number: x.id_tag_number ?? null, handling_notes: x.handling_notes ?? null, precautions: x.precautions ?? null, personal_effects: x.personal_effects ?? null,
    religious_or_cultural_considerations: x.religious_or_cultural_considerations ?? null, version: x.version, updated_by: x.updated_by ?? null, updated_at: x.updated_at ?? null,
  });

  r.get("/cases/:id/restricted", async (req, res) => {
    const c = await getCase(req.params.id);
    await needRestricted(c);
    const x = await store().get("mortuary_case_restricted", c.id);
    noStore(res);
    if (!x) throw missing("Restricted record");
    await audit(c.id, "RESTRICTED_READ", c.id);
    res.json({ record: restrictedView(x) });
  });

  r.put("/cases/:id/restricted", async (req, res) => {
    const body = restricted.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    await needRestricted(c);
    await writable(c, true);
    if (body.date_of_birth && body.date_of_death && body.date_of_death < body.date_of_birth) throw badRequest("Date of death is before date of birth");
    if (body.date_of_death && body.date_of_death > todayStr()) throw badRequest("Date of death is in the future");
    const { expected_version, ...fields } = body;
    const values = {
      decedent_full_name: fields.decedent_full_name, date_of_birth: fields.date_of_birth ?? null, date_of_death: fields.date_of_death ?? null, place_of_death: fields.place_of_death ?? null,
      id_tag_number: fields.id_tag_number ?? null, handling_notes: fields.handling_notes ?? null, precautions: fields.precautions ?? null, personal_effects: fields.personal_effects ?? null,
      religious_or_cultural_considerations: fields.religious_or_cultural_considerations ?? null, updated_by: actorId(), updated_at: now().toISOString(),
    };
    const prior = await store().get("mortuary_case_restricted", c.id);
    let saved: Row;
    if (expected_version === 0) {
      if (prior) throw versionConflict(prior);
      try {
        saved = await store().insert("mortuary_case_restricted", { id: c.id, ...values, version: 1 });
      } catch (e) {
        if (isConflict(e)) throw versionConflict(await store().get("mortuary_case_restricted", c.id));
        throw e;
      }
      await store().update("mortuary_cases", c.id, { has_restricted_record: true });
    } else {
      if (!prior) throw versionConflict(null);
      saved = await bump("mortuary_case_restricted", prior, expected_version, values);
    }
    await audit(c.id, "RESTRICTED_WRITE", c.id);
    noStore(res);
    res.json({ record: restrictedView(saved) });
  });

  const grantView = (g: Row, m: Row | null) => ({ member_id: g.member_id, email: m?.email ?? null, role: m?.role ?? null, granted_by: g.granted_by ?? null, granted_at: g.created_at, revoked_at: g.revoked_at ?? null });

  r.get("/cases/:id/access", async (req, res) => {
    owner();
    const c = await getCase(req.params.id);
    const grants = await store().list("mortuary_case_access", { case_id: c.id }, { ...ALL, order: "created_at", ascending: true });
    const ids = unique(grants.map((g) => String(g.member_id)));
    const members = ids.length ? await store().list("memberships", { id: ids }, ALL) : [];
    res.json({ grants: grants.map((g) => grantView(g, members.find((m) => m.id === g.member_id) ?? null)) });
  });

  r.post("/cases/:id/access", async (req, res) => {
    owner();
    const { member_id } = z.object({ member_id: uuid }).strict().parse(req.body);
    const c = await getCase(req.params.id);
    const m = await store().get("memberships", member_id);
    if (!m || m.disabled_at || !["OWNER", "DISPATCHER"].includes(String(m.role))) throw badRequest("Grant access only to an active owner or dispatcher of this company");
    const [active] = await store().list("mortuary_case_access", { case_id: c.id, member_id, revoked_at: null }, { limit: 1 });
    if (active) return void res.json({ grant: grantView(active, m) });
    let g: Row;
    try {
      g = await store().insert("mortuary_case_access", { case_id: c.id, member_id, granted_by: actorId(), revoked_at: null });
    } catch (e) {
      if (!isConflict(e)) throw e;
      const [won] = await store().list("mortuary_case_access", { case_id: c.id, member_id, revoked_at: null }, { limit: 1 });
      return void res.json({ grant: grantView(won!, m) });
    }
    await audit(c.id, "ACCESS_GRANTED", member_id);
    res.status(201).json({ grant: grantView(g, m) });
  });

  r.post("/cases/:id/access/:memberId/revoke", async (req, res) => {
    owner();
    const c = await getCase(req.params.id);
    const memberId = uuid.parse(req.params.memberId);
    const [active] = await store().list("mortuary_case_access", { case_id: c.id, member_id: memberId, revoked_at: null }, { limit: 1 });
    if (!active) throw missing("Active grant");
    const g = await store().update("mortuary_case_access", active.id, { revoked_at: now().toISOString(), revoked_by: actorId() }, { revoked_at: null });
    if (!g) throw fail(409, "CONFLICT", "This grant was just revoked");
    await audit(c.id, "ACCESS_REVOKED", memberId);
    res.json({ grant: grantView(g, await store().get("memberships", memberId)) });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Dispatch
  // ════════════════════════════════════════════════════════════════════════════
  const windowProblem = (start: string, end: string) => {
    const ms = Date.parse(end) - Date.parse(start);
    if (!(ms > 0)) return "Scheduled arrival must be after departure";
    if (ms > MAX_LEG_WINDOW_HOURS * 3_600_000) return `A leg window can be at most ${MAX_LEG_WINDOW_HOURS} hours`;
    return null;
  };

  r.get("/cases/:id/legs", async (req, res) => {
    const c = await getCase(req.params.id);
    const legs = await store().list<Leg>("mortuary_transport_legs", { case_id: c.id }, ALL);
    res.json({ legs: legs.sort((a, b) => a.seq - b.seq).map(legView) });
  });

  r.post("/cases/:id/legs", async (req, res) => {
    const body = legCreate.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    await writable(c);
    const w = windowProblem(body.scheduled_departure_at, body.scheduled_arrival_at);
    if (w) throw badRequest(w);
    if (body.mode === "GROUND" && body.carrier) throw badRequest("Ground legs use a company driver and vehicle, not a carrier");
    const created = await once<Leg>("mortuary_transport_legs", body, (hash) =>
      numbered(async () => {
        const legs = await store().list<Leg>("mortuary_transport_legs", { case_id: c.id }, ALL);
        const seq = legs.reduce((m, l) => Math.max(m, l.seq), 0) + 1;
        return store().insert<Leg>("mortuary_transport_legs", {
          case_id: c.id, request_key: body.request_key, request_hash: hash, seq, mode: body.mode, from_place: body.from, to_place: body.to,
          scheduled_departure_at: body.scheduled_departure_at, scheduled_arrival_at: body.scheduled_arrival_at, carrier: body.carrier ?? null,
          driver_id: null, vehicle_id: null, status: "PLANNED", version: 1, updated_at: now().toISOString(),
        });
      }),
    );
    res.status(created.replayed ? 200 : 201).json({ leg: legView(created.row), ...(created.replayed ? { replayed: true } : {}) });
  });

  /** Every reason this driver and vehicle cannot take this window. The database re-checks overlaps under lock. */
  async function assignmentProblems(leg: Leg, driverId: string, vehicleId: string, win: { start: string; end: string }) {
    const p: string[] = [];
    const [driver, vehicle] = await Promise.all([store().get("drivers", driverId), store().get("trucks", vehicleId)]);
    if (!driver) p.push("Driver not found");
    else if (["OUT_OF_SERVICE", "OFF_DUTY"].includes(String(driver.status))) p.push(`Driver is ${String(driver.status).toLowerCase().replace(/_/g, " ")}`);
    else if (driver.status === "ON_TRIP") p.push("Driver is on a freight trip");
    if (!vehicle) p.push("Vehicle not found");
    else if (["OUT_OF_SERVICE", "OFF_DUTY"].includes(String(vehicle.status))) p.push(`Vehicle is ${String(vehicle.status).toLowerCase().replace(/_/g, " ")}`);
    else if (vehicle.status === "ON_TRIP") p.push("Vehicle is on a freight trip");
    const busy = async (col: "driver_id" | "vehicle_id", id: string, who: string) => {
      const legs = await store().list<Leg>("mortuary_transport_legs", { [col]: id, status: [...LEG_ACTIVE] }, ALL);
      for (const o of legs.filter((x) => x.id !== leg.id && overlaps(win, { start: x.scheduled_departure_at, end: x.scheduled_arrival_at }))) {
        const oc = await store().get("mortuary_cases", o.case_id);
        p.push(`${who} is already on ${oc?.case_number ?? "another case"} leg ${o.seq} (${iso(o.scheduled_departure_at)} – ${iso(o.scheduled_arrival_at)})`);
      }
    };
    if (driver) await busy("driver_id", driverId, "Driver");
    if (vehicle) await busy("vehicle_id", vehicleId, "Vehicle");
    return p;
  }
  const assignConflict = (problems: string[]) => fail(409, "ASSIGNMENT_CONFLICT", "This assignment conflicts with other work", problems);

  r.patch("/cases/:id/legs/:legId", async (req, res) => {
    const body = legPatch.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    await writable(c);
    const leg = await child<Leg>("mortuary_transport_legs", c, req.params.legId, "Leg");
    if (leg.status !== "PLANNED" && leg.status !== "ASSIGNED") throw fail(409, "CONFLICT", `A ${leg.status} leg cannot be edited`);
    if (leg.mode === "GROUND" && body.carrier) throw badRequest("Ground legs do not take a carrier");
    const win = { start: body.scheduled_departure_at ?? leg.scheduled_departure_at, end: body.scheduled_arrival_at ?? leg.scheduled_arrival_at };
    const w = windowProblem(iso(win.start), iso(win.end));
    if (w) throw badRequest(w);
    if (leg.status === "ASSIGNED" && leg.mode === "GROUND" && (body.scheduled_departure_at || body.scheduled_arrival_at)) {
      const p = await assignmentProblems(leg, leg.driver_id!, leg.vehicle_id!, win);
      if (p.length) throw assignConflict(p);
    }
    const patch: Record<string, unknown> = { updated_at: now().toISOString() };
    if (body.from) patch.from_place = body.from;
    if (body.to) patch.to_place = body.to;
    if (body.scheduled_departure_at) patch.scheduled_departure_at = body.scheduled_departure_at;
    if (body.scheduled_arrival_at) patch.scheduled_arrival_at = body.scheduled_arrival_at;
    if (body.carrier !== undefined) patch.carrier = body.carrier;
    try {
      res.json({ leg: legView(await bump<Leg>("mortuary_transport_legs", leg, body.expected_version, patch)) });
    } catch (e) {
      if (isConflict(e) && !(e instanceof HttpError)) throw assignConflict([(e as Error).message.replace(/^Database: /, "")]);
      throw e;
    }
  });

  r.post("/cases/:id/legs/:legId/assignment", async (req, res) => {
    const body = assignment.parse(req.body);
    await onboarded();
    const c = await getCase(req.params.id);
    await writable(c);
    const leg = await child<Leg>("mortuary_transport_legs", c, req.params.legId, "Leg");
    if (leg.status !== "PLANNED" && leg.status !== "ASSIGNED") throw fail(409, "INVALID_TRANSITION", `A ${leg.status} leg cannot be assigned`);
    if (leg.version !== body.expected_version) throw versionConflict(leg);
    let patch: Record<string, unknown>;
    if (leg.mode === "GROUND") {
      if (!body.driver_id || !body.vehicle_id || body.carrier) throw badRequest("A ground leg is assigned a driver_id and a vehicle_id");
      const p = await assignmentProblems(leg, body.driver_id, body.vehicle_id, { start: leg.scheduled_departure_at, end: leg.scheduled_arrival_at });
      if (body.dry_run) return void res.json({ ok: p.length === 0, problems: p });
      if (p.length) throw assignConflict(p);
      patch = { driver_id: body.driver_id, vehicle_id: body.vehicle_id };
    } else {
      if (!body.carrier || body.driver_id || body.vehicle_id) throw badRequest("Air and partner legs are assigned a carrier");
      if (body.dry_run) return void res.json({ ok: true, problems: [] });
      patch = { carrier: body.carrier };
    }
    try {
      const updated = await bump<Leg>("mortuary_transport_legs", leg, body.expected_version, { ...patch, status: "ASSIGNED", assigned_at: now().toISOString(), updated_at: now().toISOString() }, { status: leg.status });
      res.json({ leg: legView(updated) });
    } catch (e) {
      // The database refused under lock: another dispatcher took this driver or vehicle a moment ago.
      if (isConflict(e) && !(e instanceof HttpError)) throw assignConflict([(e as Error).message.replace(/^Database: /, "")]);
      throw e;
    }
  });

  r.post("/cases/:id/legs/:legId/unassign", async (req, res) => {
    const { expected_version } = z.object({ expected_version: version }).strict().parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    const leg = await child<Leg>("mortuary_transport_legs", c, req.params.legId, "Leg");
    if (leg.status !== "ASSIGNED") throw fail(409, "INVALID_TRANSITION", "Only an assigned leg can be unassigned");
    const updated = await bump<Leg>("mortuary_transport_legs", leg, expected_version, { status: "PLANNED", driver_id: null, vehicle_id: null, ...(leg.mode === "GROUND" ? {} : { carrier: null }), assigned_at: null, updated_at: now().toISOString() }, { status: "ASSIGNED" });
    res.json({ leg: legView(updated) });
  });

  r.post("/cases/:id/legs/:legId/status", async (req, res) => {
    const body = legStatus.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    const leg = await child<Leg>("mortuary_transport_legs", c, req.params.legId, "Leg");
    res.json({ leg: legView(await moveLeg(ctx, c, leg, body)) });
  });

  r.get("/dispatch/board", async (req, res) => {
    const q = z.object({ from: instant, to: instant }).strict().parse(req.query);
    const span = Date.parse(q.to) - Date.parse(q.from);
    if (!(span > 0) || span > 14 * 86_400_000) throw badRequest("Choose a window of up to 14 days");
    const legs = (await store().list<Leg>("mortuary_transport_legs", { status: ["PLANNED", ...LEG_ACTIVE] }, { limit: 2000 }))
      .filter((l) => overlaps({ start: q.from, end: q.to }, { start: l.scheduled_departure_at, end: l.scheduled_arrival_at }))
      .sort((a, b) => Date.parse(a.scheduled_departure_at) - Date.parse(b.scheduled_departure_at))
      .slice(0, 500);
    const caseIds = unique(legs.map((l) => l.case_id));
    const cases = caseIds.length ? await store().list<Case>("mortuary_cases", { id: caseIds }, ALL) : [];
    const byId = new Map(cases.map((x) => [x.id, x]));
    res.json({ legs: legs.map((l) => ({ ...legView(l), case_number: byId.get(l.case_id)?.case_number ?? null, service_type: byId.get(l.case_id)?.service_type ?? null })) });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Chain of custody
  // ════════════════════════════════════════════════════════════════════════════
  r.get("/cases/:id/custody-events", async (req, res) => {
    const q = z.object({ after_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(200) }).strict().parse(req.query);
    const c = await getCase(req.params.id);
    res.json(await custodyPage(ctx, c, q.after_seq, q.limit));
  });

  r.post("/cases/:id/custody-events", async (req, res) => {
    const body = custodyBody.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    const out = await recordCustody(ctx, c, body, { driver: false });
    res.status(out.replayed ? 200 : 201).json(out.replayed ? { event: out.event, current_custodian: out.current_custodian, replayed: true } : { event: out.event, current_custodian: out.current_custodian });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Documents
  // ════════════════════════════════════════════════════════════════════════════
  r.get("/cases/:id/documents", async (req, res) => {
    const c = await getCase(req.params.id);
    const docs = await store().list("mortuary_documents", { case_id: c.id }, { ...ALL, order: "created_at", ascending: true });
    res.json({ documents: docs.map(docView) });
  });

  r.post("/cases/:id/documents", async (req, res) => {
    const body = docCreate.parse(req.body);
    person();
    await profile();
    const c = await getCase(req.params.id);
    await writable(c, true);
    const created = await once("mortuary_documents", body, (hash) => {
      const id = randomUUID();
      // The path proves which company and case a file belongs to; it never carries a name or case number.
      const path = `${org()}/${c.id}/${id}.${CONTENT_TYPES[body.content_type]}`;
      return store().insert("mortuary_documents", {
        id, case_id: c.id, request_key: body.request_key, request_hash: hash, category: body.category, status: "UPLOAD_PENDING", path,
        file_name: body.file_name, content_type: body.content_type, size_bytes: body.size_bytes, uploaded_by: actorId(), version: 1,
      });
    });
    const d = created.row;
    let upload = null;
    if (d.status === "UPLOAD_PENDING") {
      try {
        const u = await ctx.mortuaryFiles().uploadUrl(String(d.path));
        upload = { signed_url: u.signedUrl, token: u.token, expires_in_seconds: 7200 };
      } catch (e) {
        throw fail(Number((e as { status?: number }).status) === 503 ? 503 : 502, "STORAGE_UNAVAILABLE", "Storage is unavailable; retry with the same request_key");
      }
    }
    noStore(res);
    res.status(created.replayed ? 200 : 201).json({ document: docView(d), upload, ...(created.replayed ? { replayed: true } : {}) });
  });

  r.post("/cases/:id/documents/:docId/uploaded", async (req, res) => {
    const { expected_version } = z.object({ expected_version: version }).strict().parse(req.body);
    person();
    const c = await getCase(req.params.id);
    const d = await child("mortuary_documents", c, req.params.docId, "Document");
    if (d.status !== "UPLOAD_PENDING") throw fail(409, "INVALID_TRANSITION", `The document is already ${d.status}`);
    if (d.version !== expected_version) throw versionConflict(d);
    const files = ctx.mortuaryFiles();
    if (!files.exists) throw fail(503, "STORAGE_UNAVAILABLE", "Storage cannot confirm uploads here");
    let present: boolean;
    try {
      present = await files.exists(String(d.path));
    } catch {
      throw fail(502, "STORAGE_UNAVAILABLE", "Storage could not be checked; try again");
    }
    if (!present) throw fail(409, "UPLOAD_NOT_FOUND", "The file has not arrived in storage yet");
    const updated = await bump("mortuary_documents", d, expected_version, { status: "RECEIVED", uploaded_at: now().toISOString(), uploaded_by: actorId() }, { status: "UPLOAD_PENDING" });
    res.json({ document: docView(updated) });
  });

  r.post("/cases/:id/documents/:docId/review", async (req, res) => {
    const body = review.parse(req.body);
    const c = await getCase(req.params.id);
    await needRestricted(c);
    const d = await child("mortuary_documents", c, req.params.docId, "Document");
    if (d.status !== "RECEIVED") throw fail(409, "INVALID_TRANSITION", d.status === "UPLOAD_PENDING" ? "The file has not been uploaded" : "This document was already reviewed; upload a new one to review again");
    if (body.decision === "REJECTED" && !body.note) throw badRequest("Say why the document was rejected");
    const updated = await bump("mortuary_documents", d, body.expected_version, { status: body.decision, reviewed_by: actorId(), reviewed_at: now().toISOString(), review_note: body.note ?? null }, { status: "RECEIVED" });
    await audit(c.id, "DOCUMENT_REVIEW", d.id);
    res.json({ document: docView(updated) });
  });

  r.post("/cases/:id/documents/:docId/download-url", async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const c = await getCase(req.params.id);
    await needRestricted(c);
    const d = await child("mortuary_documents", c, req.params.docId, "Document");
    if (d.status === "UPLOAD_PENDING") throw fail(409, "INVALID_TRANSITION", "The file has not been uploaded");
    let url: string;
    try {
      url = await ctx.mortuaryFiles().downloadUrl(String(d.path), 120);
    } catch {
      throw fail(502, "STORAGE_UNAVAILABLE", "Storage is unavailable; try again");
    }
    await audit(c.id, "DOCUMENT_DOWNLOAD_URL", d.id);
    noStore(res);
    res.json({ url, expires_in_seconds: 120 });
  });

  r.get("/cases/:id/checklist", async (req, res) => {
    const c = await getCase(req.params.id);
    const f = await facts(c);
    res.json({ items: f.items, complete: f.items.every((i) => i.state === "APPROVED"), notice: CHECKLIST_NOTICE });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Quotes and invoices
  // ════════════════════════════════════════════════════════════════════════════
  const price = (lines: MortuaryChargeLine[]) => {
    try {
      return priceLines(lines);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  };

  r.get("/cases/:id/billing", async (req, res) => {
    const c = await getCase(req.params.id);
    const [quotes, invoices] = await Promise.all([
      store().list("mortuary_quotes", { case_id: c.id }, { ...ALL, order: "created_at", ascending: true }),
      store().list("mortuary_invoices", { case_id: c.id }, { ...ALL, order: "created_at", ascending: true }),
    ]);
    res.json({ quotes: quotes.map(quoteView), invoices: invoices.map(invoiceView) });
  });

  r.post("/cases/:id/quotes", async (req, res) => {
    const body = quoteCreate.parse(req.body);
    await profile();
    const c = await getCase(req.params.id);
    await writable(c, true);
    if (body.valid_until < todayStr()) throw badRequest("valid_until is in the past");
    const priced = price(body.lines);
    const created = await once("mortuary_quotes", body, (hash) =>
      numbered(async () => {
        const n = (await store().list("mortuary_quotes", { case_id: c.id }, ALL)).length + 1;
        return store().insert("mortuary_quotes", {
          case_id: c.id, request_key: body.request_key, request_hash: hash, number: `Q${n}`, status: "DRAFT", lines: priced.lines, subtotal_cents: priced.subtotal_cents,
          currency: "USD", valid_until: body.valid_until, notes: body.notes ?? null, version: 1,
        });
      }),
    );
    res.status(created.replayed ? 200 : 201).json({ quote: quoteView(created.row), ...(created.replayed ? { replayed: true } : {}) });
  });

  r.patch("/cases/:id/quotes/:quoteId", async (req, res) => {
    const body = quotePatch.parse(req.body);
    const c = await getCase(req.params.id);
    const q = await child("mortuary_quotes", c, req.params.quoteId, "Quote");
    if (q.status !== "DRAFT") throw fail(409, "INVALID_TRANSITION", "Only a draft quote can be edited");
    if (body.valid_until && body.valid_until < todayStr()) throw badRequest("valid_until is in the past");
    const patch: Record<string, unknown> = {};
    if (body.lines) Object.assign(patch, price(body.lines));
    if (body.valid_until) patch.valid_until = body.valid_until;
    if (body.notes !== undefined) patch.notes = body.notes;
    res.json({ quote: quoteView(await bump("mortuary_quotes", q, body.expected_version, patch, { status: "DRAFT" })) });
  });

  r.post("/cases/:id/quotes/:quoteId/issue", async (req, res) => {
    const { expected_version } = z.object({ expected_version: version }).strict().parse(req.body);
    owner();
    const c = await getCase(req.params.id);
    const q = await child("mortuary_quotes", c, req.params.quoteId, "Quote");
    if (q.status !== "DRAFT") throw fail(409, "INVALID_TRANSITION", `A ${q.status} quote cannot be issued`);
    if (String(q.valid_until) < todayStr()) throw fail(409, "INVALID_TRANSITION", "The quote's valid_until date has passed; edit it first");
    const issued = await bump("mortuary_quotes", q, expected_version, { status: "ISSUED", issued_at: now().toISOString() }, { status: "DRAFT" });
    for (const other of await store().list("mortuary_quotes", { case_id: c.id, status: "ISSUED" }, ALL)) {
      if (other.id !== issued.id) await store().update("mortuary_quotes", other.id, { status: "SUPERSEDED", version: Number(other.version) + 1 }, { status: "ISSUED", version: other.version as number });
    }
    res.json({ quote: quoteView(issued) });
  });

  r.post("/cases/:id/quotes/:quoteId/accept", async (req, res) => {
    const body = z.object({ expected_version: version, acceptance_reference: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    owner();
    const c = await getCase(req.params.id);
    const q = await child("mortuary_quotes", c, req.params.quoteId, "Quote");
    if (q.status !== "ISSUED") throw fail(409, "INVALID_TRANSITION", `A ${q.status} quote cannot be accepted`);
    if (String(q.valid_until) < todayStr()) throw fail(409, "INVALID_TRANSITION", "This quote has expired");
    res.json({ quote: quoteView(await bump("mortuary_quotes", q, body.expected_version, { status: "ACCEPTED", accepted_at: now().toISOString(), acceptance_reference: body.acceptance_reference }, { status: "ISSUED" })) });
  });

  r.post("/cases/:id/quotes/:quoteId/decline", async (req, res) => {
    const body = z.object({ expected_version: version, reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    owner();
    const c = await getCase(req.params.id);
    const q = await child("mortuary_quotes", c, req.params.quoteId, "Quote");
    if (q.status !== "ISSUED") throw fail(409, "INVALID_TRANSITION", `A ${q.status} quote cannot be declined`);
    res.json({ quote: quoteView(await bump("mortuary_quotes", q, body.expected_version, { status: "DECLINED", decline_reason: body.reason }, { status: "ISSUED" })) });
  });

  r.post("/cases/:id/invoices", async (req, res) => {
    const body = invoiceCreate.parse(req.body);
    owner();
    await profile();
    const c = await getCase(req.params.id);
    if (c.status === "CANCELED") throw fail(409, "CONFLICT", "The case is CANCELED");
    const q = await child("mortuary_quotes", c, body.quote_id, "Quote");
    if (body.due_date < todayStr()) throw badRequest("due_date is in the past");
    if (body.additional_lines.some((l) => l.category !== "ADDITIONAL")) throw badRequest("Lines added on the invoice must be ADDITIONAL charges");
    const created = await once("mortuary_invoices", body, async (hash) => {
      if (q.status !== "ACCEPTED") throw fail(409, "INVALID_TRANSITION", "Invoice an accepted quote");
      const [open] = await store().list("mortuary_invoices", { quote_id: q.id, status: "ISSUED" }, { limit: 1 });
      if (open) throw fail(409, "CONFLICT", "This quote already has an invoice; void it first");
      const priced = price([...(q.lines as MortuaryChargeLine[]), ...body.additional_lines]);
      return numbered(() => store().insert("mortuary_invoices", {
        case_id: c.id, request_key: body.request_key, request_hash: hash, quote_id: q.id, invoice_number: `MI-${todayStr().slice(0, 4)}-${code(6)}`, status: "ISSUED",
        lines: priced.lines, subtotal_cents: priced.subtotal_cents, currency: "USD", due_date: body.due_date, issued_at: now().toISOString(), version: 1,
      }));
    });
    if (!created.replayed) await enqueue(c, "invoice.issued", { invoice_number: String(created.row.invoice_number), subtotal_cents: Number(created.row.subtotal_cents) });
    res.status(created.replayed ? 200 : 201).json({ invoice: invoiceView(created.row), ...(created.replayed ? { replayed: true } : {}) });
  });

  r.post("/cases/:id/invoices/:invoiceId/void", async (req, res) => {
    const body = z.object({ expected_version: version, reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    owner();
    const c = await getCase(req.params.id);
    const i = await child("mortuary_invoices", c, req.params.invoiceId, "Invoice");
    if (i.status !== "ISSUED") throw fail(409, "INVALID_TRANSITION", "This invoice is already void");
    res.json({ invoice: invoiceView(await bump("mortuary_invoices", i, body.expected_version, { status: "VOID", voided_at: now().toISOString(), void_reason: body.reason }, { status: "ISSUED" })) });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // International coordination
  // ════════════════════════════════════════════════════════════════════════════
  async function intlCase(id: string) {
    const c = await getCase(id);
    if (!isInternational(c.service_type)) throw fail(409, "CONFLICT", "This is not an international case");
    return c;
  }
  async function needRecord(c: Case) {
    const rec = await store().get("mortuary_international", c.id);
    if (!rec) throw fail(409, "CONFLICT", "Create the international record first");
    return rec;
  }
  /** Any change to the facts behind an approval withdraws it; a person must approve again. */
  async function revokeIfApproved(caseId: string, why: string) {
    const rec = await store().get("mortuary_international", caseId);
    if (rec?.release_status !== "APPROVED") return;
    const done = await store().update("mortuary_international", caseId, { release_status: "REVOKED", release_note: why, version: Number(rec.version) + 1, updated_at: now().toISOString() }, { release_status: "APPROVED", version: rec.version as number });
    if (done) await audit(caseId, "RELEASE_REVOKED", caseId);
  }
  async function readiness(c: Case) {
    const f = await facts(c);
    const problems = releaseProblems({
      onboarding_gaps: gaps(f.profile), record: f.intl as never, requirements: f.reqs.map((q) => ({ id: q.id, authority: String(q.authority), status: String(q.status), reviewed_on: String(q.reviewed_on) })),
      checklist: f.items, open_incidents: f.incidents.length, today: todayStr(),
    });
    return { f, problems };
  }

  r.get("/cases/:id/international", async (req, res) => {
    const c = await intlCase(req.params.id);
    const { f, problems } = await readiness(c);
    const milestones = await store().list("mortuary_milestones", { case_id: c.id }, ALL);
    res.json({
      record: intlView(f.intl), requirements: f.reqs.map(requirementView),
      milestones: milestones.sort((a, b) => Date.parse(String(a.occurred_at)) - Date.parse(String(b.occurred_at))).map((m) => ({
        id: m.id, case_id: m.case_id, kind: m.kind, occurred_at: m.occurred_at, reference: m.reference ?? null, location_country: m.location_country ?? null, note: m.note ?? null,
        supersedes_id: m.supersedes_id ?? null, recorded_by: m.recorded_by, created_at: m.created_at,
      })),
      readiness: { ready: problems.length === 0, problems }, legal_clearance: false,
    });
  });

  r.put("/cases/:id/international", async (req, res) => {
    const body = intlPut.parse(req.body);
    await profile();
    const c = await intlCase(req.params.id);
    await writable(c);
    const transit = unique(body.transit_countries);
    if (body.origin_country === body.destination_country) throw badRequest("Origin and destination countries must differ");
    if (transit.length !== body.transit_countries.length || transit.some((t) => t === body.origin_country || t === body.destination_country)) throw badRequest("Transit countries must be unique and exclude origin and destination");
    const values = { origin_country: body.origin_country, destination_country: body.destination_country, transit_countries: transit, receiving_party: body.receiving_party ?? null, carrier: body.carrier ?? null, updated_at: now().toISOString() };
    const prior = await store().get("mortuary_international", c.id);
    let saved: Row;
    if (body.expected_version === 0) {
      if (prior) throw versionConflict(prior);
      try {
        saved = await store().insert("mortuary_international", { id: c.id, ...values, release_status: "NOT_REQUESTED", version: 1 });
      } catch (e) {
        if (isConflict(e)) throw versionConflict(await store().get("mortuary_international", c.id));
        throw e;
      }
    } else {
      if (!prior) throw versionConflict(null);
      const moved = prior.origin_country !== values.origin_country || prior.destination_country !== values.destination_country || canonicalJson([...((prior.transit_countries as string[]) ?? [])].sort()) !== canonicalJson([...transit].sort());
      const revoke = moved && prior.release_status === "APPROVED";
      saved = await bump("mortuary_international", prior, body.expected_version, { ...values, ...(revoke ? { release_status: "REVOKED", release_note: "Countries changed after approval" } : {}) });
      if (revoke) await audit(c.id, "RELEASE_REVOKED", c.id);
    }
    res.json({ record: intlView(saved) });
  });

  r.post("/cases/:id/international/requirements", async (req, res) => {
    const body = requirementCreate.parse(req.body);
    await profile();
    const c = await intlCase(req.params.id);
    await writable(c);
    const rec = await needRecord(c);
    if (body.reviewed_on > todayStr()) throw badRequest("reviewed_on cannot be in the future");
    const allowed = new Set([rec.origin_country, rec.destination_country, ...((rec.transit_countries as string[]) ?? [])]);
    if (body.jurisdiction_role !== "CARRIER" && !allowed.has(body.country)) throw badRequest("The country must be this case's origin, destination or a transit country");
    const created = await once("mortuary_requirements", body, (hash) => store().insert("mortuary_requirements", {
      case_id: c.id, ...body, request_hash: hash, document_category: body.document_category ?? null, reviewed_by: actorId(), status: "OPEN", status_note: null, version: 1,
    }));
    if (!created.replayed) await revokeIfApproved(c.id, "A requirement was added after approval");
    res.status(created.replayed ? 200 : 201).json({ requirement: requirementView(created.row), ...(created.replayed ? { replayed: true } : {}) });
  });

  r.patch("/cases/:id/international/requirements/:reqId", async (req, res) => {
    const body = requirementPatch.parse(req.body);
    await profile();
    const c = await intlCase(req.params.id);
    const q = await child("mortuary_requirements", c, req.params.reqId, "Requirement");
    if (body.reviewed_on && body.reviewed_on > todayStr()) throw badRequest("reviewed_on cannot be in the future");
    const status = body.status ?? q.status;
    const statusNote = body.status_note !== undefined ? body.status_note : q.status_note;
    if (status === "NOT_APPLICABLE" && !statusNote) throw badRequest("Say why the requirement does not apply");
    const patch: Record<string, unknown> = {};
    if (body.status) patch.status = body.status;
    if (body.status_note !== undefined) patch.status_note = body.status_note;
    if (body.source_reference) patch.source_reference = body.source_reference;
    if (body.reviewed_on) Object.assign(patch, { reviewed_on: body.reviewed_on, reviewed_by: actorId() });
    const updated = await bump("mortuary_requirements", q, body.expected_version, patch);
    await revokeIfApproved(c.id, "A requirement changed after approval");
    res.json({ requirement: requirementView(updated) });
  });

  r.post("/cases/:id/international/milestones", async (req, res) => {
    const body = milestoneCreate.parse(req.body);
    await profile();
    const c = await intlCase(req.params.id);
    await writable(c, true);
    await needRecord(c);
    if (Date.parse(body.occurred_at) > now().getTime() + 5 * 60_000) throw badRequest("occurred_at is in the future");
    if (body.supersedes_id) await child("mortuary_milestones", c, body.supersedes_id, "Superseded milestone");
    const created = await once("mortuary_milestones", body, (hash) => store().insert("mortuary_milestones", {
      case_id: c.id, ...body, request_hash: hash, reference: body.reference ?? null, location_country: body.location_country ?? null, note: body.note ?? null, supersedes_id: body.supersedes_id ?? null, recorded_by: actor(),
    }));
    const m = created.row;
    res.status(created.replayed ? 200 : 201).json({
      milestone: { id: m.id, case_id: m.case_id, kind: m.kind, occurred_at: m.occurred_at, reference: m.reference ?? null, location_country: m.location_country ?? null, note: m.note ?? null, supersedes_id: m.supersedes_id ?? null, recorded_by: m.recorded_by, created_at: m.created_at },
      ...(created.replayed ? { replayed: true } : {}),
    });
  });

  r.post("/cases/:id/international/release-approval", async (req, res) => {
    const body = z.object({ expected_version: version, acknowledge: z.string(), note: z.string().trim().max(500).nullish() }).strict().parse(req.body);
    owner();
    const c = await intlCase(req.params.id);
    await writable(c);
    if (body.acknowledge !== RELEASE_ACKNOWLEDGEMENT) throw badRequest("Send the acknowledgement sentence exactly as published in the contract");
    const { f, problems } = await readiness(c);
    if (problems.length) throw fail(409, "NOT_READY", "This case is not ready for release approval", problems);
    const rec = f.intl!;
    const snapshot = {
      checklist: f.items.map((i) => ({ category: i.category, state: i.state, document_ids: i.document_ids })),
      requirements: f.reqs.map((q) => ({ id: q.id, status: q.status, reviewed_on: q.reviewed_on, source_reference: q.source_reference })),
      approved_on: todayStr(),
    };
    const saved = await bump("mortuary_international", rec, body.expected_version, {
      release_status: "APPROVED", release_approved_by: actorId(), release_approved_at: now().toISOString(), release_note: body.note ?? null, release_snapshot: snapshot, updated_at: now().toISOString(),
    });
    await audit(c.id, "RELEASE_APPROVED", c.id);
    res.json({ record: intlView(saved), legal_clearance: false });
  });

  r.post("/cases/:id/international/release-approval/revoke", async (req, res) => {
    const body = z.object({ expected_version: version, reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    owner();
    const c = await intlCase(req.params.id);
    const rec = await needRecord(c);
    if (rec.release_status !== "APPROVED") throw fail(409, "INVALID_TRANSITION", "Release is not approved");
    const saved = await bump("mortuary_international", rec, body.expected_version, { release_status: "REVOKED", release_note: body.reason, updated_at: now().toISOString() }, { release_status: "APPROVED" });
    await audit(c.id, "RELEASE_REVOKED", c.id);
    res.json({ record: intlView(saved) });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Integration outbox (read-only)
  // ════════════════════════════════════════════════════════════════════════════
  r.get("/cases/:id/integration-events", async (req, res) => {
    const c = await getCase(req.params.id);
    const rows = await store().list("mortuary_integration_events", { case_id: c.id }, { ...ALL, order: "created_at", ascending: true });
    res.json({ events: rows.map((e) => ({ id: e.id, target: e.target, kind: e.kind, payload: e.payload, status: e.status, created_at: e.created_at, delivered_at: e.delivered_at ?? null })) });
  });

  return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// Shared by office and driver routes
// ══════════════════════════════════════════════════════════════════════════════
type LegStatusBody = z.infer<typeof legStatus>;

/** Move a leg forward. Custody-dependent steps are checked against the custody log. */
async function moveLeg(ctx: Ctx, c: Case, leg: Leg, body: LegStatusBody): Promise<Leg> {
  const store = ctx.store();
  if (!LEG_TRANSITIONS[leg.status].includes(body.to as MortuaryLegStatus)) throw fail(409, "INVALID_TRANSITION", `A leg cannot go from ${leg.status} to ${body.to}`);
  if (leg.version !== body.expected_version) throw versionConflict(leg);
  const at = body.occurred_at ?? ctx.now().toISOString();
  const t = Date.parse(at), n = ctx.now().getTime();
  if (t > n + 60_000 || t < n - 24 * 3_600_000) throw badRequest("occurred_at must be within the last 24 hours and not in the future");
  const p: string[] = [];
  const legEvents = effectiveEvents((await store.list<Stored>("mortuary_custody_events", { case_id: c.id }, ALL)).sort((a, b) => a.seq - b.seq)).filter((e) => e.kind === "TRANSFER" && e.leg_id === leg.id);
  const custodians = LEG_CUSTODIANS[leg.mode];
  const taken = legEvents.find((e) => custodians.includes(e.payload.receiving_party?.kind));
  let patch: Record<string, unknown> = {};
  if (body.to === "EN_ROUTE") {
    if (c.status !== "READY_FOR_DISPATCH" && c.status !== "IN_TRANSIT") p.push(`The case is ${c.status}; it must be READY_FOR_DISPATCH or IN_TRANSIT`);
    patch = { actual_departure_at: at };
  } else if (body.to === "IN_CUSTODY") {
    if (!taken) p.push(`Record the custody transfer to ${custodians.join(" or ")} on this leg first`);
    patch = { actual_pickup_at: at };
  } else if (body.to === "DELIVERED") {
    const handed = taken && legEvents.find((e) => e.seq > taken.seq && custodians.includes(e.payload.releasing_party?.kind));
    if (!handed) p.push("Record the custody transfer from this leg's custodian to the receiving party first");
    patch = { actual_delivery_at: at };
  } else {
    if (!body.reason) p.push("Give a reason");
    patch = { canceled_at: at, cancel_reason: body.reason ?? null };
  }
  if (p.length) throw fail(409, "INVALID_TRANSITION", `The leg cannot move to ${body.to}`, p);
  const updated = await store.update<Leg>("mortuary_transport_legs", leg.id, { ...patch, status: body.to, version: leg.version + 1, updated_at: ctx.now().toISOString() }, { version: leg.version, status: leg.status });
  if (!updated) throw versionConflict(await store.get("mortuary_transport_legs", leg.id));
  return updated;
}

/** The hash covers exactly these fields, normalised so a database round trip (timestamp format, key order) does not change it. */
export const hashEvent = (prev: string | null, e: { case_id: string; seq: number; kind: string; leg_id?: string | null; occurred_at: string; recorded_at: string; recorded_by: unknown; payload: unknown }) =>
  sha256(`${prev ?? ""}\n${canonicalJson({ case_id: e.case_id, seq: e.seq, kind: e.kind, leg_id: e.leg_id ?? null, occurred_at: iso(e.occurred_at), recorded_at: iso(e.recorded_at), recorded_by: e.recorded_by, payload: e.payload })}`);

/** Recompute the chain; any edited, removed or reordered row breaks it. */
export function chainValid(events: readonly Stored[]): boolean {
  let prev: string | null = null;
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1 || (e.prev_hash ?? null) !== prev) return false;
    if (hashEvent(prev, e) !== e.hash) return false;
    prev = e.hash;
  }
  return true;
}

async function custodyPage(ctx: Ctx, c: Case, afterSeq: number, limit: number, legId?: string) {
  const all = (await ctx.store().list<Stored>("mortuary_custody_events", { case_id: c.id }, ALL)).sort((a, b) => a.seq - b.seq);
  const eff = effectiveEvents(all);
  const pool = legId ? all.filter((e) => e.leg_id === legId) : all;
  const page = pool.filter((e) => e.seq > afterSeq).slice(0, limit);
  const more = pool.filter((e) => e.seq > afterSeq).length > page.length;
  const view = (e: Stored) => ({ id: e.id, case_id: e.case_id, seq: e.seq, kind: e.kind, leg_id: e.leg_id ?? null, occurred_at: e.occurred_at, recorded_at: e.recorded_at, recorded_by: e.recorded_by, payload: e.payload, prev_hash: e.prev_hash ?? null, hash: e.hash });
  if (legId) return { events: page.map(view), next_after_seq: more ? page.at(-1)!.seq : null };
  return {
    events: page.map(view),
    effective: eff.map((e) => ({ seq: e.seq, kind: e.kind, leg_id: e.leg_id ?? null, occurred_at: e.occurred_at, payload: e.payload, corrected_by: e.corrected_by })),
    current_custodian: currentCustodian(eff),
    open_incidents: openIncidents(eff).map((e) => ({ seq: e.seq, ...e.payload })),
    chain_valid: afterSeq === 0 ? chainValid(all) : null,
    next_after_seq: more ? page.at(-1)!.seq : null,
  };
}

type CustodyInput = z.infer<typeof custodyBody>;

/** Append one custody event: idempotent by request_key, positioned by expected_seq, hash-linked to the previous event. */
async function recordCustody(ctx: Ctx, c: Case, body: CustodyInput, opts: { driver: boolean; leg?: Leg }) {
  const store = ctx.store();
  const k = currentCaller()!;
  if (c.status === "CLOSED" || c.status === "CANCELED") throw fail(409, "CONFLICT", `The case is ${c.status}`);
  const hash = requestHash(body);
  const replay = async () => {
    const [p] = await store.list<Stored>("mortuary_custody_events", { request_key: body.request_key }, { limit: 1 });
    if (!p) return null;
    if (p.request_hash !== hash) throw fail(409, "IDEMPOTENCY_KEY_REUSED", "This request_key was already used for a different request");
    return p;
  };
  const view = async (e: Stored) => ({ id: e.id, case_id: e.case_id, seq: e.seq, kind: e.kind, leg_id: e.leg_id ?? null, occurred_at: e.occurred_at, recorded_at: e.recorded_at, recorded_by: e.recorded_by, payload: e.payload, prev_hash: e.prev_hash ?? null, hash: e.hash });
  const seen = await replay();
  if (seen) return { event: await view(seen), current_custodian: currentCustodian(effectiveEvents(await sortedCustody(ctx, c.id))), replayed: true };

  if (opts.driver && !["IDENTITY_CHECK", "TRANSFER", "CHECKPOINT", "INCIDENT"].includes(body.kind)) throw forbidden("Drivers record identity checks, transfers, checkpoints and incidents");
  if (body.kind === "CORRECTION" && (k.kind !== "user" || opts.driver)) throw forbidden("Corrections are made by a signed-in owner or dispatcher");

  const events = await sortedCustody(ctx, c.id);
  const last = events.at(-1) ?? null;
  if (body.expected_seq !== (last?.seq ?? 0)) throw fail(409, "SEQUENCE_CONFLICT", "New custody events were recorded; reload and try again", undefined, { last_seq: last?.seq ?? 0 });

  const t = Date.parse(body.occurred_at), n = ctx.now().getTime();
  if (t > n + 5 * 60_000 || t < n - 30 * 86_400_000) throw badRequest("occurred_at must be within the last 30 days and not in the future");

  let legId = body.leg_id ?? null;
  if (opts.leg) {
    if (legId && legId !== opts.leg.id) throw badRequest("This event belongs to the leg in the URL");
    legId = opts.leg.id;
  } else if (legId) {
    const leg = await store.get<Leg>("mortuary_transport_legs", legId);
    if (!leg || leg.case_id !== c.id) throw missing("Leg");
  }

  const effective = effectiveEvents(events);
  let payload: Record<string, unknown>;
  const problems: string[] = [];
  switch (body.kind) {
    case "IDENTITY_CHECK": {
      const p = PAYLOADS.IDENTITY_CHECK.parse(body.payload);
      const onFile = (await store.get("mortuary_case_restricted", c.id))?.id_tag_number as string | null | undefined;
      const check = tagCheck(onFile, p.observed_tag);
      // The observed tag is compared and dropped: only the outcome of the comparison is kept.
      payload = { method: p.method, outcome: check === "MISMATCH" ? "DISCREPANCY" : p.outcome, tag_check: check, note: p.note ?? null };
      break;
    }
    case "TRANSFER": {
      const p = PAYLOADS.TRANSFER.parse(body.payload);
      problems.push(...transferProblems(effective, p.releasing_party));
      for (const party of [p.releasing_party, p.receiving_party]) {
        if (party.driver_id && !(await store.get("drivers", party.driver_id))) problems.push(`Driver ${party.name} is not one of this company's drivers`);
      }
      for (const a of [p.releasing_acknowledgment, p.receiving_acknowledgment]) {
        if (Date.parse(a.acknowledged_at) > n + 5 * 60_000) problems.push("An acknowledgment is dated in the future");
        if (a.document_id) {
          const d = await store.get("mortuary_documents", a.document_id);
          if (!d || d.case_id !== c.id || d.category !== "CUSTODY_ACKNOWLEDGMENT" || d.status === "UPLOAD_PENDING" || d.status === "REJECTED") problems.push("Signature documents must be uploaded CUSTODY_ACKNOWLEDGMENT documents of this case");
        }
      }
      payload = p;
      break;
    }
    case "CHECKPOINT":
      payload = PAYLOADS.CHECKPOINT.parse(body.payload);
      break;
    case "INCIDENT":
      payload = { incident_key: randomUUID(), ...PAYLOADS.INCIDENT.parse(body.payload) };
      break;
    case "INCIDENT_RESOLVED": {
      const p = PAYLOADS.INCIDENT_RESOLVED.parse(body.payload);
      if (!openIncidents(effective).some((e) => e.payload.incident_key === p.incident_key)) problems.push("That incident is not open on this case");
      payload = p;
      break;
    }
    case "CORRECTION": {
      const p = PAYLOADS.CORRECTION.parse(body.payload);
      const target = events.find((e) => e.seq === p.corrects_seq);
      if (!target) throw badRequest(`There is no event ${p.corrects_seq} on this case`);
      if (target.kind === "CORRECTION") throw badRequest("A correction cannot be corrected; correct the original event");
      if (!p.changes.occurred_at && !p.changes.payload) throw badRequest("Say what the correction changes");
      if (p.changes.payload) CORRECTABLE[target.kind as keyof typeof CORRECTABLE].parse(p.changes.payload);
      payload = p;
      break;
    }
  }
  if (problems.length) throw fail(409, "INVALID_TRANSITION", `This ${body.kind.toLowerCase().replace(/_/g, " ")} cannot be recorded`, problems);

  const recorded_at = ctx.now().toISOString();
  const recorded_by = k.kind === "user" && k.member ? { kind: "USER", user_id: k.user.id, member_id: k.member.id, role: opts.driver ? "DRIVER" : k.member.role } : { kind: "PLATFORM" };
  const row = { case_id: c.id, seq: (last?.seq ?? 0) + 1, kind: body.kind, leg_id: legId, occurred_at: body.occurred_at, recorded_at, recorded_by, payload };
  const prev_hash = last?.hash ?? null;
  let saved: Stored;
  try {
    saved = await store.insert<Stored>("mortuary_custody_events", { ...row, request_key: body.request_key, request_hash: hash, prev_hash, hash: hashEvent(prev_hash, row) });
  } catch (e) {
    if (!isConflict(e)) throw e;
    const won = await replay();
    if (won) return { event: await view(won), current_custodian: currentCustodian(effectiveEvents(await sortedCustody(ctx, c.id))), replayed: true };
    const latest = (await sortedCustody(ctx, c.id)).at(-1);
    throw fail(409, "SEQUENCE_CONFLICT", "Another custody event was recorded at the same moment; reload and try again", undefined, { last_seq: latest?.seq ?? 0 });
  }
  return { event: await view(saved), current_custodian: currentCustodian(effectiveEvents([...events, saved])), replayed: false };
}

async function sortedCustody(ctx: Ctx, caseId: string) {
  return (await ctx.store().list<Stored>("mortuary_custody_events", { case_id: caseId }, ALL)).sort((a, b) => a.seq - b.seq);
}

// ══════════════════════════════════════════════════════════════════════════════
// Driver app: only legs assigned to the caller's driver record
// ══════════════════════════════════════════════════════════════════════════════
export function mortuaryDriverRoutes(ctx: Ctx) {
  const r = Router();
  r.use((_req: Request, res: Response, next: NextFunction) => {
    const c = currentCaller();
    if (!c) return res.status(401).json({ error: "Sign in first", code: "UNAUTHENTICATED" });
    if (c.kind !== "user" || !c.member) return res.status(403).json({ error: "Sign in as a driver", code: "FORBIDDEN" });
    if (!c.member.driver_id) return res.status(403).json({ error: "Your account is not linked to a driver yet; ask the owner", code: "FORBIDDEN" });
    next();
  });
  const me = () => (currentCaller() as { member: Member }).member.driver_id!;
  async function myLeg(id: string) {
    const leg = await ctx.store().get<Leg>("mortuary_transport_legs", uuid.parse(id));
    if (!leg || leg.driver_id !== me()) throw missing("Leg");
    const c = await ctx.store().get<Case>("mortuary_cases", leg.case_id);
    if (!c) throw missing("Leg");
    return { leg, c };
  }
  const driverLeg = (l: Leg, c: Case | undefined) => ({
    id: l.id, case_id: l.case_id, case_number: c?.case_number ?? null, seq: l.seq, mode: l.mode, from: l.from_place, to: l.to_place,
    scheduled_departure_at: l.scheduled_departure_at, scheduled_arrival_at: l.scheduled_arrival_at, status: l.status, version: l.version, vehicle_id: l.vehicle_id ?? null,
  });

  r.get("/legs", async (_req, res) => {
    const legs = await ctx.store().list<Leg>("mortuary_transport_legs", { driver_id: me(), status: [...LEG_ACTIVE] }, ALL);
    const caseIds = [...new Set(legs.map((l) => l.case_id))];
    const cases = caseIds.length ? await ctx.store().list<Case>("mortuary_cases", { id: caseIds }, ALL) : [];
    res.json({ legs: legs.sort((a, b) => Date.parse(a.scheduled_departure_at) - Date.parse(b.scheduled_departure_at)).map((l) => driverLeg(l, cases.find((c) => c.id === l.case_id))) });
  });

  r.post("/legs/:legId/status", async (req, res) => {
    const body = legStatus.parse(req.body);
    if (body.to === "CANCELED") throw forbidden("Dispatch cancels legs");
    const { leg, c } = await myLeg(req.params.legId);
    const moved = await moveLeg(ctx, c, leg, body);
    res.json({ leg: driverLeg(moved, c) });
  });

  r.get("/legs/:legId/custody-events", async (req, res) => {
    const { leg, c } = await myLeg(req.params.legId);
    res.json(await custodyPage(ctx, c, 0, 200, leg.id));
  });

  r.post("/legs/:legId/custody-events", async (req, res) => {
    const body = custodyBody.parse(req.body);
    const { leg, c } = await myLeg(req.params.legId);
    if (!LEG_ACTIVE.includes(leg.status)) throw fail(409, "CONFLICT", `The leg is ${leg.status}`);
    const out = await recordCustody(ctx, c, body, { driver: true, leg });
    res.status(out.replayed ? 200 : 201).json(out.replayed ? { event: out.event, current_custodian: out.current_custodian, replayed: true } : { event: out.event, current_custodian: out.current_custodian });
  });
  return r;
}
