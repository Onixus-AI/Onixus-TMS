/** Shapes from Onixus TMS–Mortuary API contract 1.1.0. */

export type CaseStatus = "INTAKE" | "AWAITING_RELEASE" | "READY_FOR_DISPATCH" | "IN_TRANSIT" | "ON_HOLD" | "DELIVERED" | "CLOSED" | "CANCELED";
export type ServiceType = "FIRST_CALL_REMOVAL" | "DOMESTIC_TRANSFER" | "AIRPORT_TRANSFER" | "INTERNATIONAL_INBOUND" | "INTERNATIONAL_OUTBOUND";
export type LegStatus = "PLANNED" | "ASSIGNED" | "EN_ROUTE" | "IN_CUSTODY" | "DELIVERED" | "CANCELED";
export type LegMode = "GROUND" | "AIR" | "PARTNER";
export type DocumentCategory =
  | "RELEASE_AUTHORIZATION" | "DEATH_CERTIFICATE" | "TRANSIT_PERMIT" | "EMBALMING_CERTIFICATE" | "NON_CONTAGION_CERTIFICATE"
  | "CONSULAR_DOCUMENT" | "DECEDENT_PASSPORT" | "AIRWAY_BILL" | "CARRIER_BOOKING" | "CUSTODY_ACKNOWLEDGMENT"
  | "IDENTIFICATION_RECORD" | "INVOICE_SUPPORT" | "OTHER";
export type ChecklistState = "MISSING" | "PENDING_UPLOAD" | "AWAITING_REVIEW" | "REJECTED" | "APPROVED";
export type ReleaseStatus = "NOT_REQUESTED" | "APPROVED" | "REVOKED";
export type Role = "OWNER" | "DISPATCHER" | "DRIVER";

export interface Place {
  name: string;
  facility_type: string;
  address_line?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country: string;
}

export interface Party {
  kind: string;
  name: string;
  organization?: string | null;
  title?: string | null;
  driver_id?: string | null;
}

export interface MortuaryCase {
  id: string;
  case_number: string;
  service_type: ServiceType;
  international: boolean;
  requesting_organization: { name: string; type: string; phone?: string | null; email?: string | null };
  crm_system?: string | null;
  crm_account_ref?: string | null;
  authorized_contacts: { name: string; relationship: string; phone?: string | null; email?: string | null; may_authorize_release: boolean; crm_contact_ref?: string | null }[];
  origin: Place;
  destination: Place;
  coordinator_member_id?: string | null;
  required_document_categories: string[];
  mail_thread_refs: string[];
  status: CaseStatus;
  held_from_status?: CaseStatus | null;
  version: number;
  has_restricted_record: boolean;
  restricted_access: boolean;
  created_at: string;
  updated_at: string;
}

export interface CaseSummary {
  current_custodian: Party | null;
  open_incidents: number;
  legs: { total: number; delivered: number; canceled: number };
  checklist: { required: number; approved: number; missing: string[]; awaiting_review: string[] };
  international: { release_status: ReleaseStatus; stale_requirements: number; open_requirements: number } | null;
}

export interface CaseDetail {
  case: MortuaryCase;
  summary: CaseSummary;
}

export interface Leg {
  id: string;
  case_id: string;
  seq: number;
  mode: LegMode;
  from: Place;
  to: Place;
  scheduled_departure_at: string;
  scheduled_arrival_at: string;
  driver_id?: string | null;
  vehicle_id?: string | null;
  carrier?: { name: string; flight_number?: string | null; airway_bill?: string | null; partner_reference?: string | null } | null;
  status: LegStatus;
  assigned_at?: string | null;
  actual_departure_at?: string | null;
  actual_pickup_at?: string | null;
  actual_delivery_at?: string | null;
  canceled_at?: string | null;
  cancel_reason?: string | null;
  version: number;
}

export interface BoardLeg extends Leg {
  case_number: string;
  service_type: ServiceType;
}

export interface ChecklistItem {
  category: string;
  sources: string[];
  state: ChecklistState;
  document_ids: string[];
}

export interface Checklist {
  items: ChecklistItem[];
  complete: boolean;
  notice: string;
}

export interface DocumentRow {
  id: string;
  case_id: string;
  category: string;
  status: "UPLOAD_PENDING" | "RECEIVED" | "APPROVED" | "REJECTED";
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_at?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  version: number;
}

export interface UploadTarget {
  signed_url: string;
  token: string;
  expires_in_seconds: number;
}

export interface CustodyEvent {
  id: string;
  case_id: string;
  seq: number;
  kind: string;
  leg_id?: string | null;
  occurred_at: string;
  recorded_at: string;
  recorded_by: { kind: string; role?: string | null; member_id?: string | null };
  payload: Record<string, unknown>;
  hash?: string | null;
}

export interface CustodyPage {
  events: CustodyEvent[];
  effective: { seq: number; kind: string; occurred_at: string; payload: Record<string, unknown>; corrected_by?: number[] }[];
  current_custodian: Party | null;
  open_incidents: { seq: number; incident_key: string; severity: string; category: string; description: string }[];
  chain_valid: boolean | null;
  next_after_seq: number | null;
}

export interface Requirement {
  id: string;
  country: string;
  jurisdiction_role: string;
  authority: string;
  description: string;
  document_category?: string | null;
  source_type: string;
  source_reference: string;
  reviewed_on: string;
  status: "OPEN" | "SATISFIED" | "NOT_APPLICABLE";
  stale: boolean;
  version: number;
}

export interface Milestone {
  id: string;
  kind: string;
  occurred_at: string;
  reference?: string | null;
  location_country?: string | null;
  note?: string | null;
  supersedes_id?: string | null;
}

export interface InternationalRecord {
  case_id: string;
  origin_country: string;
  destination_country: string;
  transit_countries: string[];
  receiving_party?: { name: string; organization?: string | null; role: string; country: string; phone?: string | null; email?: string | null } | null;
  carrier?: { name: string; iata_code?: string | null; booking_reference?: string | null } | null;
  release_status: ReleaseStatus;
  release_approved_at?: string | null;
  release_note?: string | null;
  version: number;
}

export interface InternationalView {
  record: InternationalRecord | null;
  requirements: Requirement[];
  milestones: Milestone[];
  readiness: { ready: boolean; problems: string[] };
  legal_clearance: boolean;
}

export interface ChargeLine {
  category: string;
  description: string;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
}

export interface Quote {
  id: string;
  case_id: string;
  number: string;
  status: "DRAFT" | "ISSUED" | "ACCEPTED" | "SUPERSEDED" | "DECLINED";
  lines: ChargeLine[];
  subtotal_cents: number;
  currency: "USD";
  valid_until: string;
  notes?: string | null;
  decline_reason?: string | null;
  version: number;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  status: "ISSUED" | "VOID";
  lines: ChargeLine[];
  subtotal_cents: number;
  currency: "USD";
  due_date: string;
  payment: { status: string; provider: string | null; verified_at: string | null; notice: string };
  version: number;
}

export interface IntegrationEvent {
  id: string;
  target: "CRM" | "MAIL";
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
  delivered_at?: string | null;
}

export interface HistoryRow {
  id: string;
  from_status: string | null;
  to_status: string;
  reason?: string | null;
  actor: { kind: string; role?: string | null };
  created_at: string;
}

export interface RestrictedRecord {
  case_id: string;
  decedent_full_name: string;
  date_of_birth?: string | null;
  date_of_death?: string | null;
  id_tag_number?: string | null;
  handling_notes?: string | null;
  version: number;
}

export interface FleetOption {
  id: string;
  label: string;
}

export type QueueId = "active" | "unassigned_pickups" | "upcoming_transfers" | "missing_documents" | "past_window" | "needs_approval";

export interface Metric {
  id: QueueId;
  label: string;
  detail: string;
  count: number;
}

export interface AttentionItem {
  caseId: string;
  caseNumber: string;
  line: string;
}

export interface OperationsSnapshot {
  asOf: string;
  metrics: Metric[];
  attention: AttentionItem[];
  caseIdsByQueue: Record<QueueId, string[]>;
  partialError: string | null;
}
