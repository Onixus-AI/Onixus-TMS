import type { MortuaryClient } from "./client";
import { MortuaryError } from "./client";
import type { BoardLeg, CaseDetail, Checklist, CustodyPage, DocumentRow, InternationalView, Leg, MortuaryCase, Quote, Invoice } from "./types";

const AS_OF = "2026-10-22T14:00:00.000Z";
const NOTICE = "Operational checklist configured by staff. It is not a statement of legal requirements.";

function place(name: string, city: string, region: string, country: string, facility: string) {
  return { name, facility_type: facility, city, region, country };
}

function baseCase(partial: Partial<MortuaryCase> & Pick<MortuaryCase, "id" | "case_number" | "service_type" | "status" | "origin" | "destination" | "requesting_organization">): MortuaryCase {
  return {
    international: partial.service_type.startsWith("INTERNATIONAL"),
    authorized_contacts: [],
    required_document_categories: [],
    mail_thread_refs: [],
    version: 1,
    has_restricted_record: false,
    restricted_access: false,
    created_at: "2026-10-20T15:00:00.000Z",
    updated_at: AS_OF,
    ...partial,
  };
}

const CASES: MortuaryCase[] = [
  baseCase({
    id: "11111111-1111-4111-8111-111111111111",
    case_number: "MC-2410",
    service_type: "DOMESTIC_TRANSFER",
    status: "IN_TRANSIT",
    requesting_organization: { name: "Harbor Sample Home", type: "FUNERAL_HOME" },
    origin: place("Sample Holding Room", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    destination: place("Harbor Chapel", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    coordinator_member_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }),
  baseCase({
    id: "22222222-2222-4222-8222-222222222222",
    case_number: "MC-2408",
    service_type: "FIRST_CALL_REMOVAL",
    status: "READY_FOR_DISPATCH",
    requesting_organization: { name: "Sample Chapel of Eastwick", type: "FUNERAL_HOME" },
    origin: place("Eastwick Medical Center", "Atlanta", "GA", "US", "HOSPITAL"),
    destination: place("Sample Chapel of Eastwick", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    crm_system: "HUBSPOT",
    crm_account_ref: "hubspot-fixture-2408",
    mail_thread_refs: ["veltra-thread-fixture-2408"],
  }),
  baseCase({
    id: "33333333-3333-4333-8333-333333333333",
    case_number: "MC-2412",
    service_type: "AIRPORT_TRANSFER",
    status: "AWAITING_RELEASE",
    requesting_organization: { name: "Lakeside Sample Partners", type: "FUNERAL_HOME" },
    origin: place("Lakeside receiving desk", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    destination: place("Sample Air cargo desk", "Atlanta", "GA", "US", "AIRPORT_CARGO"),
  }),
  baseCase({
    id: "44444444-4444-4444-8444-444444444444",
    case_number: "MC-2419",
    service_type: "INTERNATIONAL_OUTBOUND",
    status: "AWAITING_RELEASE",
    requesting_organization: { name: "Sample Chapel of Eastwick", type: "FUNERAL_HOME" },
    origin: place("Sample Chapel of Eastwick", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    destination: place("Accra Receiving Partners desk", "Accra", "Greater Accra", "GH", "FUNERAL_HOME"),
    has_restricted_record: true,
    restricted_access: true,
  }),
  baseCase({
    id: "55555555-5555-4555-8555-555555555555",
    case_number: "MC-2415",
    service_type: "DOMESTIC_TRANSFER",
    status: "IN_TRANSIT",
    requesting_organization: { name: "Northline Sample Directors", type: "FUNERAL_HOME" },
    origin: place("Northline preparation room", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    destination: place("Northline chapel", "Atlanta", "GA", "US", "FUNERAL_HOME"),
  }),
  baseCase({
    id: "66666666-6666-4666-8666-666666666666",
    case_number: "MC-2390",
    service_type: "DOMESTIC_TRANSFER",
    status: "CLOSED",
    requesting_organization: { name: "Harbor Sample Home", type: "FUNERAL_HOME" },
    origin: place("Harbor Chapel", "Atlanta", "GA", "US", "FUNERAL_HOME"),
    destination: place("Harbor Chapel", "Atlanta", "GA", "US", "FUNERAL_HOME"),
  }),
];

const LEGS: BoardLeg[] = [
  {
    id: "leg-2408", case_id: CASES[1].id, case_number: "MC-2408", service_type: "FIRST_CALL_REMOVAL", seq: 1, mode: "GROUND", status: "PLANNED", version: 1,
    from: CASES[1].origin, to: CASES[1].destination, driver_id: null, vehicle_id: null,
    scheduled_departure_at: "2026-10-22T16:00:00.000Z", scheduled_arrival_at: "2026-10-22T18:00:00.000Z",
  },
  {
    id: "leg-2415", case_id: CASES[4].id, case_number: "MC-2415", service_type: "DOMESTIC_TRANSFER", seq: 1, mode: "GROUND", status: "EN_ROUTE", version: 3,
    from: CASES[4].origin, to: CASES[4].destination, driver_id: "driver-ortiz", vehicle_id: "van-t14",
    scheduled_departure_at: "2026-10-22T12:00:00.000Z", scheduled_arrival_at: "2026-10-22T13:00:00.000Z",
  },
  {
    id: "leg-2410", case_id: CASES[0].id, case_number: "MC-2410", service_type: "DOMESTIC_TRANSFER", seq: 1, mode: "GROUND", status: "IN_CUSTODY", version: 4,
    from: CASES[0].origin, to: CASES[0].destination, driver_id: "driver-ortiz", vehicle_id: "van-t14",
    scheduled_departure_at: "2026-10-22T15:00:00.000Z", scheduled_arrival_at: "2026-10-22T17:00:00.000Z",
  },
];

const CHECKLISTS: Record<string, Checklist> = {
  [CASES[0].id]: { complete: true, notice: NOTICE, items: [{ category: "RELEASE_AUTHORIZATION", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-1"] }, { category: "TRANSIT_PERMIT", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-2"] }] },
  [CASES[1].id]: { complete: true, notice: NOTICE, items: [{ category: "RELEASE_AUTHORIZATION", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-3"] }] },
  [CASES[2].id]: { complete: false, notice: NOTICE, items: [{ category: "RELEASE_AUTHORIZATION", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-4"] }, { category: "TRANSIT_PERMIT", sources: ["SERVICE_TYPE"], state: "MISSING", document_ids: [] }] },
  [CASES[3].id]: { complete: true, notice: NOTICE, items: [{ category: "RELEASE_AUTHORIZATION", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-5"] }, { category: "DEATH_CERTIFICATE", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-6"] }, { category: "TRANSIT_PERMIT", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-7"] }, { category: "AIRWAY_BILL", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-8"] }] },
  [CASES[4].id]: { complete: true, notice: NOTICE, items: [{ category: "RELEASE_AUTHORIZATION", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-9"] }, { category: "TRANSIT_PERMIT", sources: ["SERVICE_TYPE"], state: "APPROVED", document_ids: ["doc-10"] }] },
  [CASES[5].id]: { complete: true, notice: NOTICE, items: [] },
};

function detail(item: MortuaryCase): CaseDetail {
  const international = item.id === CASES[3].id
    ? { release_status: "NOT_REQUESTED" as const, stale_requirements: 0, open_requirements: 0 }
    : null;
  return {
    case: item,
    summary: {
      current_custodian: item.status === "IN_TRANSIT" ? { kind: "TRANSPORT_STAFF", name: "Sample Driver Ortiz", driver_id: "driver-ortiz" } : null,
      open_incidents: 0,
      legs: { total: LEGS.filter((leg) => leg.case_id === item.id).length, delivered: 0, canceled: 0 },
      checklist: {
        required: CHECKLISTS[item.id]?.items.length ?? 0,
        approved: CHECKLISTS[item.id]?.items.filter((row) => row.state === "APPROVED").length ?? 0,
        missing: CHECKLISTS[item.id]?.items.filter((row) => row.state === "MISSING").map((row) => row.category) ?? [],
        awaiting_review: [],
      },
      international,
    },
  };
}

const EMPTY_CUSTODY: CustodyPage = { events: [], effective: [], current_custodian: null, open_incidents: [], chain_valid: true, next_after_seq: null };

const INTERNATIONAL: InternationalView = {
  record: {
    case_id: CASES[3].id,
    origin_country: "US",
    destination_country: "GH",
    transit_countries: [],
    receiving_party: { name: "Sample Receiving Desk", organization: "Accra Receiving Partners (sample)", role: "FUNERAL_HOME", country: "GH" },
    carrier: { name: "Sample Air Cargo", iata_code: "SA", booking_reference: "FLT-SAMPLE-418" },
    release_status: "NOT_REQUESTED",
    version: 2,
  },
  requirements: [{
    id: "req-1", country: "GH", jurisdiction_role: "DESTINATION", authority: "Sample receiving partner", description: "Configured destination packet from the sample record.",
    document_category: "AIRWAY_BILL", source_type: "AGENT_ADVICE", source_reference: "sample-letter-418", reviewed_on: "2026-10-21", status: "SATISFIED", stale: false, version: 1,
  }],
  milestones: [{ id: "ms-1", kind: "DOCUMENTS_SUBMITTED", occurred_at: "2026-10-21T15:00:00.000Z", reference: "sample-submit" }],
  readiness: { ready: true, problems: [] },
  legal_clearance: false,
};

const QUOTE: Quote = {
  id: "quote-1", case_id: CASES[0].id, number: "Q1", status: "ISSUED", currency: "USD", valid_until: "2026-11-22", version: 2, subtotal_cents: 48500,
  lines: [{ category: "SERVICE", description: "Local transfer", quantity: 1, unit_cents: 48500, amount_cents: 48500 }],
};

const INVOICE: Invoice = {
  id: "inv-1", invoice_number: "MI-2026-000001", status: "ISSUED", currency: "USD", due_date: "2026-11-22", version: 1, subtotal_cents: 48500,
  lines: QUOTE.lines,
  payment: { status: "NOT_VERIFIED", provider: null, verified_at: null, notice: "Payment collection is not connected. No charge will be made from this screen." },
};

/** Fictional contract-shaped records for tests. live is always false. */
export class MockMortuaryClient implements MortuaryClient {
  readonly source = "mock" as const;
  readonly live = false;
  private fault: { action: string; message: string } | null = null;
  private custodyPage: CustodyPage = EMPTY_CUSTODY;
  private internationalView: InternationalView = structuredClone(INTERNATIONAL);
  private seen = new Map<string, { event: CustodyPage["events"][number] }>();

  armFault(action: string, message = "The server did not record this. No receipt was issued.") {
    this.fault = { action, message };
  }

  async listCases() {
    return { cases: CASES.map((item) => ({ ...item, authorized_contacts: [] })), next_cursor: null };
  }
  async getCase(id: string) {
    const item = CASES.find((row) => row.id === id);
    if (!item) throw new MortuaryError(404, "Case not found", "NOT_FOUND");
    return detail(item);
  }
  async createCase(input: Parameters<MortuaryClient["createCase"]>[0]) {
    const created = baseCase({
      id: "77777777-7777-4777-8777-777777777777",
      case_number: input.case_number ?? "MC-NEW",
      service_type: input.service_type,
      status: "INTAKE",
      requesting_organization: input.requesting_organization,
      origin: { ...input.origin },
      destination: { ...input.destination },
    });
    return { case: created, replayed: false };
  }
  async listLegs(caseId: string) {
    return LEGS.filter((leg) => leg.case_id === caseId);
  }
  async dispatchBoard() {
    return LEGS;
  }
  async assignLeg(_caseId: string, legId: string, body: { expected_version: number; driver_id: string; vehicle_id: string }) {
    const leg = LEGS.find((item) => item.id === legId);
    if (!leg) throw new MortuaryError(404, "Leg not found", "NOT_FOUND");
    return { ...leg, status: "ASSIGNED" as const, driver_id: body.driver_id, vehicle_id: body.vehicle_id, version: body.expected_version + 1, assigned_at: AS_OF };
  }
  async checklist(caseId: string) {
    return CHECKLISTS[caseId] ?? { items: [], complete: false, notice: NOTICE };
  }
  async documents(): Promise<DocumentRow[]> {
    return [];
  }
  async createDocument(): Promise<{ document: DocumentRow; upload: null; replayed: boolean }> {
    throw new MortuaryError(501, "Upload is not part of this sample.", "NOT_IMPLEMENTED");
  }
  async putUpload() {}
  async markUploaded(): Promise<DocumentRow> {
    throw new MortuaryError(501, "Upload is not part of this sample.", "NOT_IMPLEMENTED");
  }
  async downloadDocument(): Promise<{ url: string; expires_in_seconds: number }> {
    throw new MortuaryError(501, "Downloads are not available in the sample.", "NOT_IMPLEMENTED");
  }
  async reviewDocument(): Promise<DocumentRow> {
    throw new MortuaryError(501, "Review is not part of this sample.", "NOT_IMPLEMENTED");
  }
  async custody(): Promise<CustodyPage> {
    return this.custodyPage;
  }
  async recordCustody(_caseId: string, body: Parameters<MortuaryClient["recordCustody"]>[1]) {
    if (this.fault?.action === "custody") {
      const message = this.fault.message;
      this.fault = null;
      throw new MortuaryError(409, message, "INVALID_TRANSITION");
    }
    const prior = this.seen.get(body.request_key);
    if (prior) return { event: prior.event, current_custodian: this.custodyPage.current_custodian, replayed: true };
    const event = {
      id: `evt-${this.custodyPage.events.length + 1}`,
      case_id: CASES[1].id,
      seq: body.expected_seq + 1,
      kind: body.kind,
      leg_id: body.leg_id ?? null,
      occurred_at: body.occurred_at,
      recorded_at: "2026-10-22T14:01:00.000Z",
      recorded_by: { kind: "USER", role: "DISPATCHER" },
      payload: body.payload,
    };
    this.custodyPage = {
      ...this.custodyPage,
      events: [...this.custodyPage.events, event],
      effective: [...this.custodyPage.effective, { seq: event.seq, kind: event.kind, occurred_at: event.occurred_at, payload: event.payload }],
      current_custodian: body.kind === "TRANSFER" ? (body.payload.receiving_party as CustodyPage["current_custodian"]) : this.custodyPage.current_custodian,
    };
    this.seen.set(body.request_key, { event });
    return { event, current_custodian: this.custodyPage.current_custodian, replayed: false };
  }
  async international() {
    return this.internationalView;
  }
  async approveRelease(_caseId: string, body: { expected_version: number; acknowledge: string }) {
    if (body.acknowledge !== "I have reviewed the documents and requirements for this case. This is an internal release decision, not legal clearance.") {
      throw new MortuaryError(400, "Send the acknowledgement sentence exactly as published in the contract", "BAD_REQUEST");
    }
    if (!this.internationalView.record) throw new MortuaryError(409, "No international record", "CONFLICT");
    this.internationalView = {
      ...this.internationalView,
      legal_clearance: false,
      record: { ...this.internationalView.record, release_status: "APPROVED", release_approved_at: "2026-10-22T14:01:00.000Z", version: body.expected_version + 1 },
    };
    return { record: this.internationalView.record, legal_clearance: false as const };
  }
  async billing(caseId: string) {
    if (caseId !== CASES[0].id) return { quotes: [], invoices: [] };
    return { quotes: [QUOTE], invoices: [INVOICE] };
  }
  async integrationEvents(caseId: string) {
    if (caseId !== CASES[1].id) return [];
    return [{ id: "evt-mail", target: "MAIL" as const, kind: "case.opened", payload: { case_id: caseId, case_number: "MC-2408" }, status: "PENDING", created_at: AS_OF, delivered_at: null }];
  }
  async history() {
    return [{ id: "hist-1", from_status: null, to_status: "INTAKE", actor: { kind: "USER", role: "DISPATCHER" }, created_at: "2026-10-20T15:00:00.000Z" }];
  }
  async restricted(caseId: string) {
    if (caseId !== CASES[3].id) throw new MortuaryError(404, "No restricted record", "NOT_FOUND");
    return { case_id: caseId, decedent_full_name: "Sample Restricted Name", id_tag_number: "TAG-SAMPLE", version: 1 };
  }
  async driverLegs() {
    return LEGS.filter((leg) => leg.driver_id === "driver-ortiz");
  }
  async driverCustody() {
    return this.custodyPage;
  }
  async driverRecordCustody(legId: string, body: Parameters<MortuaryClient["recordCustody"]>[1]) {
    return this.recordCustody(CASES[1].id, { ...body, leg_id: legId });
  }
}

export function sampleCaseId(number: string): string {
  return CASES.find((item) => item.case_number === number)?.id ?? "";
}

export type { Leg };
