// Mortuary case rules shared by the API (and readable by the web app).
// Pure functions only: no I/O, no clock, no crypto. The API supplies "now".
// This encodes operational workflow. It is not a statement of law: nothing
// here grants legal clearance or decides what a jurisdiction requires.

export const CASE_STATUSES = ['INTAKE', 'AWAITING_RELEASE', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'ON_HOLD', 'DELIVERED', 'CLOSED', 'CANCELED'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const SERVICE_TYPES = ['FIRST_CALL_REMOVAL', 'DOMESTIC_TRANSFER', 'AIRPORT_TRANSFER', 'INTERNATIONAL_INBOUND', 'INTERNATIONAL_OUTBOUND'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export const isInternational = (t: string) => t === 'INTERNATIONAL_INBOUND' || t === 'INTERNATIONAL_OUTBOUND';

export const FACILITY_TYPES = ['HOSPITAL', 'HOSPICE', 'RESIDENCE', 'MEDICAL_EXAMINER', 'FUNERAL_HOME', 'AIRPORT_CARGO', 'CEMETERY', 'CREMATORY', 'OTHER'] as const;
export const PARTY_KINDS = ['RELEASING_FACILITY', 'TRANSPORT_STAFF', 'FUNERAL_HOME', 'AIRLINE_CARGO', 'RECEIVING_AGENT', 'FAMILY_REPRESENTATIVE', 'MEDICAL_EXAMINER', 'OTHER'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const DOCUMENT_CATEGORIES = [
  'RELEASE_AUTHORIZATION', 'DEATH_CERTIFICATE', 'TRANSIT_PERMIT', 'EMBALMING_CERTIFICATE', 'NON_CONTAGION_CERTIFICATE', 'CONSULAR_DOCUMENT',
  'DECEDENT_PASSPORT', 'AIRWAY_BILL', 'CARRIER_BOOKING', 'CUSTODY_ACKNOWLEDGMENT', 'IDENTIFICATION_RECORD', 'INVOICE_SUPPORT', 'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
export const DOCUMENT_STATUSES = ['UPLOAD_PENDING', 'RECEIVED', 'APPROVED', 'REJECTED'] as const;

/** Operational defaults per service type. Staff and international requirements add to these. */
export const DEFAULT_CHECKLIST: Record<ServiceType, readonly DocumentCategory[]> = {
  FIRST_CALL_REMOVAL: ['RELEASE_AUTHORIZATION'],
  DOMESTIC_TRANSFER: ['RELEASE_AUTHORIZATION', 'TRANSIT_PERMIT'],
  AIRPORT_TRANSFER: ['RELEASE_AUTHORIZATION', 'TRANSIT_PERMIT'],
  INTERNATIONAL_INBOUND: ['RELEASE_AUTHORIZATION', 'DEATH_CERTIFICATE', 'TRANSIT_PERMIT', 'AIRWAY_BILL'],
  INTERNATIONAL_OUTBOUND: ['RELEASE_AUTHORIZATION', 'DEATH_CERTIFICATE', 'TRANSIT_PERMIT', 'AIRWAY_BILL'],
};
export const CHECKLIST_NOTICE = 'Operational checklist configured by staff. It is not a statement of legal requirements.';

// ── Case status machine ────────────────────────────────────────────────────

export const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  INTAKE: ['AWAITING_RELEASE', 'ON_HOLD', 'CANCELED'],
  AWAITING_RELEASE: ['READY_FOR_DISPATCH', 'ON_HOLD', 'CANCELED'],
  READY_FOR_DISPATCH: ['IN_TRANSIT', 'AWAITING_RELEASE', 'ON_HOLD', 'CANCELED'],
  IN_TRANSIT: ['DELIVERED', 'ON_HOLD'],
  ON_HOLD: ['INTAKE', 'AWAITING_RELEASE', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'CANCELED'],
  DELIVERED: ['CLOSED'],
  CLOSED: [],
  CANCELED: [],
};
/** Cases that no longer change. */
export const CASE_FINISHED: readonly CaseStatus[] = ['DELIVERED', 'CLOSED', 'CANCELED'];
const NEEDS_REASON = new Set<CaseStatus>(['ON_HOLD', 'CANCELED']);

/** What the guards need to know; the API gathers it. */
export type CaseFacts = {
  status: CaseStatus;
  held_from_status: CaseStatus | null;
  international: boolean;
  onboarding_gaps: string[];
  checklist_incomplete: string[];
  release_status: string | null;
  custodian: PartyKind | null;
  open_legs: number;
  open_incidents: number;
};

/** Every reason a case cannot move to `to`, or [] when it can. */
export function caseTransitionProblems(f: CaseFacts, to: CaseStatus, reason?: string | null): string[] {
  if (f.status === to) return [`The case is already ${to}`];
  if (!CASE_TRANSITIONS[f.status].includes(to)) return [`A case cannot go from ${f.status} to ${to}`];
  if (f.status === 'ON_HOLD' && to !== 'CANCELED' && to !== f.held_from_status) return [`Resume the case to ${f.held_from_status ?? 'its previous status'}`];
  const p: string[] = [];
  const backwards = f.status === 'READY_FOR_DISPATCH' && to === 'AWAITING_RELEASE';
  if ((NEEDS_REASON.has(to) || backwards) && !reason?.trim()) p.push('Give a reason');
  const withUs = f.custodian === 'TRANSPORT_STAFF';
  if (to === 'CANCELED' && withUs) p.push('Company transport staff hold custody; release custody before canceling');
  if (to === 'READY_FOR_DISPATCH') {
    p.push(...f.onboarding_gaps.map((g) => `Onboarding: ${g}`));
    p.push(...f.checklist_incomplete.map((c) => `Document not approved: ${c}`));
    if (f.international && f.release_status !== 'APPROVED') p.push('International release approval has not been recorded');
  }
  if (to === 'IN_TRANSIT' && !withUs) p.push('Record the custody transfer to company transport staff first');
  if (to === 'DELIVERED') {
    if (withUs) p.push('Record the custody transfer to the receiving party first');
    if (f.open_legs > 0) p.push(`${f.open_legs} leg(s) are not delivered or canceled`);
  }
  if (to === 'CLOSED' && f.open_incidents > 0) p.push(`${f.open_incidents} custody incident(s) are unresolved`);
  return p;
}

// ── Legs ───────────────────────────────────────────────────────────────────

export const LEG_MODES = ['GROUND', 'AIR', 'PARTNER'] as const;
export type LegMode = (typeof LEG_MODES)[number];
export const MORTUARY_LEG_STATUSES = ['PLANNED', 'ASSIGNED', 'EN_ROUTE', 'IN_CUSTODY', 'DELIVERED', 'CANCELED'] as const;
export type MortuaryLegStatus = (typeof MORTUARY_LEG_STATUSES)[number];
/** Legs that hold a driver or vehicle. */
export const LEG_ACTIVE: readonly MortuaryLegStatus[] = ['ASSIGNED', 'EN_ROUTE', 'IN_CUSTODY'];
export const LEG_TRANSITIONS: Record<MortuaryLegStatus, readonly MortuaryLegStatus[]> = {
  PLANNED: ['CANCELED'], // ASSIGNED only through the assignment endpoint
  ASSIGNED: ['EN_ROUTE', 'CANCELED'],
  EN_ROUTE: ['IN_CUSTODY', 'CANCELED'],
  IN_CUSTODY: ['DELIVERED'],
  DELIVERED: [],
  CANCELED: [],
};
/** Who holds custody while a leg of this mode is under way. */
export const LEG_CUSTODIANS: Record<LegMode, readonly PartyKind[]> = {
  GROUND: ['TRANSPORT_STAFF'],
  AIR: ['AIRLINE_CARGO'],
  PARTNER: ['RECEIVING_AGENT', 'FUNERAL_HOME'],
};
export const MAX_LEG_WINDOW_HOURS = 72;

export type Window = { start: string; end: string };
export const overlaps = (a: Window, b: Window) => new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);

// ── Chain of custody ───────────────────────────────────────────────────────

export const CUSTODY_KINDS = ['IDENTITY_CHECK', 'TRANSFER', 'CHECKPOINT', 'INCIDENT', 'INCIDENT_RESOLVED', 'CORRECTION'] as const;
export type CustodyKind = (typeof CUSTODY_KINDS)[number];
export type Party = { kind: PartyKind; name: string; organization?: string | null; title?: string | null; driver_id?: string | null };
export type CustodyEvent = { seq: number; kind: CustodyKind; leg_id?: string | null; occurred_at: string; payload: Record<string, any> };
export type EffectiveEvent = CustodyEvent & { corrected_by: number[] };

/** Fields a correction may never change. */
export const UNCORRECTABLE = ['incident_key'] as const;

/** The log with every correction applied in order; corrections themselves drop out. The originals are untouched. */
export function effectiveEvents(events: readonly CustodyEvent[]): EffectiveEvent[] {
  const out = new Map<number, EffectiveEvent>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind !== 'CORRECTION') {
      out.set(e.seq, { ...e, payload: structuredClone(e.payload), corrected_by: [] });
      continue;
    }
    const target = out.get(Number(e.payload.corrects_seq));
    if (!target) continue;
    const changes = e.payload.changes ?? {};
    if (changes.occurred_at) target.occurred_at = changes.occurred_at;
    if (changes.payload) {
      const patch = { ...changes.payload };
      for (const k of UNCORRECTABLE) delete patch[k];
      target.payload = { ...target.payload, ...patch };
    }
    target.corrected_by.push(e.seq);
  }
  return [...out.values()];
}

/** Who holds custody now: the receiving party of the latest effective transfer. */
export function currentCustodian(effective: readonly EffectiveEvent[]): Party | null {
  const transfers = effective.filter((e) => e.kind === 'TRANSFER');
  return (transfers.at(-1)?.payload.receiving_party as Party | undefined) ?? null;
}

/** Incident keys raised and not yet resolved. */
export function openIncidents(effective: readonly EffectiveEvent[]): EffectiveEvent[] {
  const resolved = new Set(effective.filter((e) => e.kind === 'INCIDENT_RESOLVED').map((e) => e.payload.incident_key));
  return effective.filter((e) => e.kind === 'INCIDENT' && !resolved.has(e.payload.incident_key));
}

/** Whether a verified identity check exists since the last transfer (or since the start). */
export function identityVerifiedSinceLastTransfer(effective: readonly EffectiveEvent[]): boolean {
  let ok = false;
  for (const e of effective) {
    if (e.kind === 'TRANSFER') ok = false;
    else if (e.kind === 'IDENTITY_CHECK') ok = e.payload.outcome === 'VERIFIED';
  }
  return ok;
}

/** Problems with appending a transfer to this log. */
export function transferProblems(effective: readonly EffectiveEvent[], releasing: Party): string[] {
  const p: string[] = [];
  if (!identityVerifiedSinceLastTransfer(effective)) p.push('Record a verified identity check before this transfer');
  const holder = currentCustodian(effective);
  if (holder && holder.kind !== releasing.kind) p.push(`The releasing party must be the current custodian (${holder.kind})`);
  return p;
}

/** Compare an observed tag with the one on file, normalising case and spacing. The observed value is not kept. */
export function tagCheck(onFile: string | null | undefined, observed: string | null | undefined): 'MATCH' | 'MISMATCH' | 'NOT_ON_FILE' | 'NOT_PROVIDED' {
  if (!observed?.trim()) return 'NOT_PROVIDED';
  if (!onFile?.trim()) return 'NOT_ON_FILE';
  const n = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  return n(onFile) === n(observed) ? 'MATCH' : 'MISMATCH';
}

/** Deterministic JSON (sorted keys) so the custody hash chain can be recomputed anywhere. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// ── Documents checklist ────────────────────────────────────────────────────

export type ChecklistDoc = { id: string; category: string; status: string };
export type ChecklistItem = { category: string; sources: string[]; state: 'MISSING' | 'PENDING_UPLOAD' | 'AWAITING_REVIEW' | 'REJECTED' | 'APPROVED'; document_ids: string[] };

export function checklist(serviceType: ServiceType, caseExtras: readonly string[], requirementCategories: readonly string[], docs: readonly ChecklistDoc[]): ChecklistItem[] {
  const sources = new Map<string, string[]>();
  const add = (c: string, s: string) => {
    const cur = sources.get(c) ?? [];
    if (!cur.includes(s)) cur.push(s);
    sources.set(c, cur);
  };
  DEFAULT_CHECKLIST[serviceType].forEach((c) => add(c, 'SERVICE_TYPE'));
  caseExtras.forEach((c) => add(c, 'CASE'));
  requirementCategories.forEach((c) => add(c, 'REQUIREMENT'));
  return [...sources].map(([category, s]) => {
    const mine = docs.filter((d) => d.category === category);
    const has = (st: string) => mine.some((d) => d.status === st);
    const state = has('APPROVED') ? 'APPROVED' : has('RECEIVED') ? 'AWAITING_REVIEW' : has('UPLOAD_PENDING') ? 'PENDING_UPLOAD' : has('REJECTED') ? 'REJECTED' : 'MISSING';
    return { category, sources: s, state, document_ids: mine.map((d) => d.id) };
  });
}

// ── International ──────────────────────────────────────────────────────────

export const REQUIREMENT_STALE_DAYS = 90;
export const RELEASE_ACKNOWLEDGEMENT = 'I have reviewed the documents and requirements for this case. This is an internal release decision, not legal clearance.';

/** Days between two YYYY-MM-DD dates (b - a). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const requirementStale = (reviewedOn: string, today: string) => daysBetween(reviewedOn, today) > REQUIREMENT_STALE_DAYS;

export type ReleaseFacts = {
  onboarding_gaps: string[];
  record: { receiving_party?: unknown } | null;
  requirements: { id: string; authority: string; status: string; reviewed_on: string }[];
  checklist: ChecklistItem[];
  open_incidents: number;
  today: string;
};

export function releaseProblems(f: ReleaseFacts): string[] {
  const p = f.onboarding_gaps.map((g) => `Onboarding: ${g}`);
  if (!f.record) return [...p, 'Create the international record first'];
  if (!f.record.receiving_party) p.push('Add the receiving funeral home or agent');
  for (const r of f.requirements) {
    if (r.status === 'OPEN') p.push(`Requirement still open: ${r.authority}`);
    if (r.status !== 'NOT_APPLICABLE' && requirementStale(r.reviewed_on, f.today)) p.push(`Requirement review older than ${REQUIREMENT_STALE_DAYS} days: ${r.authority}`);
  }
  for (const c of f.checklist) if (c.state !== 'APPROVED') p.push(`Document not approved: ${c.category}`);
  if (f.open_incidents) p.push(`${f.open_incidents} custody incident(s) are unresolved`);
  return p;
}

// ── Billing ────────────────────────────────────────────────────────────────

export const CHARGE_CATEGORIES = ['SERVICE', 'MILEAGE', 'ADDITIONAL'] as const;
export type MortuaryChargeLine = { category: (typeof CHARGE_CATEGORIES)[number]; code?: string | null; description: string; quantity: number; unit_cents: number; amount_cents?: number };
export const MAX_TOTAL_CENTS = 99_999_999;

/** Lines with their amounts worked out, and the subtotal. Throws when the total is out of range. */
export function priceLines(lines: readonly MortuaryChargeLine[]): { lines: Required<MortuaryChargeLine>[]; subtotal_cents: number } {
  const priced = lines.map((l) => {
    if (!(Number.isFinite(l.quantity) && l.quantity > 0 && Number.isInteger(l.unit_cents) && l.unit_cents > 0)) throw new RangeError('Each line needs a positive quantity and price');
    return { category: l.category, code: l.code ?? null, description: l.description, quantity: l.quantity, unit_cents: l.unit_cents, amount_cents: Math.round(l.quantity * l.unit_cents) };
  });
  const subtotal_cents = priced.reduce((s, l) => s + l.amount_cents, 0);
  if (subtotal_cents > MAX_TOTAL_CENTS) throw new RangeError('The total is too large');
  return { lines: priced as Required<MortuaryChargeLine>[], subtotal_cents };
}

// ── Integration events ─────────────────────────────────────────────────────

export const INTEGRATION_TARGETS = ['CRM', 'MAIL'] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];

/**
 * The only fields any other system ever receives about a case. Built from an
 * allow-list so a new column on the case can never leak by accident.
 */
export function integrationPayload(
  c: { id: string; case_number: string; service_type: string; status: string; crm_system?: string | null; crm_account_ref?: string | null; mail_thread_refs?: string[] | null },
  target: IntegrationTarget,
  extra: { invoice_number?: string; subtotal_cents?: number } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = { case_id: c.id, case_number: c.case_number, service_type: c.service_type, status: c.status };
  if (target === 'CRM') Object.assign(base, { crm_system: c.crm_system ?? null, crm_account_ref: c.crm_account_ref ?? null });
  if (target === 'MAIL') base.mail_thread_refs = [...(c.mail_thread_refs ?? [])];
  if (extra.invoice_number) Object.assign(base, { invoice_number: extra.invoice_number, subtotal_cents: extra.subtotal_cents });
  return base;
}

/** Which targets a case has references for. */
export function integrationTargets(c: { crm_account_ref?: string | null; mail_thread_refs?: string[] | null }, kind: string): IntegrationTarget[] {
  const t: IntegrationTarget[] = [];
  if (c.crm_account_ref) t.push('CRM');
  if (kind !== 'invoice.issued' && c.mail_thread_refs?.length) t.push('MAIL');
  return t;
}
