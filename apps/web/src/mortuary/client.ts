import type {
  BoardLeg, CaseDetail, CaseStatus, Checklist, CustodyPage, DocumentRow, HistoryRow, IntegrationEvent,
  InternationalView, Invoice, Leg, MortuaryCase, Quote, RestrictedRecord, ServiceType, UploadTarget,
} from "./types";

export class MortuaryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "MortuaryError";
  }
}

export function errorText(error: unknown): string {
  if (error instanceof MortuaryError) {
    const extra = error.problems.length ? ` ${error.problems.join(" ")}` : "";
    return error.code ? `${error.message} (${error.code}).${extra}` : `${error.message}.${extra}`;
  }
  return error instanceof Error ? error.message : "The request failed.";
}

export interface CaseListQuery {
  status?: CaseStatus[];
  serviceType?: ServiceType;
  coordinatorMemberId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface CreateCaseInput {
  request_key: string;
  case_number?: string;
  service_type: ServiceType;
  requesting_organization: { name: string; type: string; phone?: string; email?: string };
  origin: { name: string; facility_type: string; city?: string; region?: string; country: string };
  destination: { name: string; facility_type: string; city?: string; region?: string; country: string };
}

export interface CustodyInput {
  request_key: string;
  expected_seq: number;
  kind: "IDENTITY_CHECK" | "TRANSFER";
  leg_id?: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

/** Office and driver calls defined by contract 1.1.0. Implementations must not invent records. */
export interface MortuaryClient {
  readonly source: "http" | "mock";
  readonly live: boolean;
  listCases(query?: CaseListQuery): Promise<{ cases: MortuaryCase[]; next_cursor: string | null }>;
  getCase(id: string): Promise<CaseDetail>;
  createCase(input: CreateCaseInput): Promise<{ case: MortuaryCase; replayed: boolean }>;
  listLegs(caseId: string): Promise<Leg[]>;
  dispatchBoard(from: string, to: string): Promise<BoardLeg[]>;
  assignLeg(caseId: string, legId: string, body: { expected_version: number; driver_id: string; vehicle_id: string }): Promise<Leg>;
  checklist(caseId: string): Promise<Checklist>;
  documents(caseId: string): Promise<DocumentRow[]>;
  createDocument(caseId: string, body: { request_key: string; category: string; file_name: string; content_type: string; size_bytes: number }): Promise<{ document: DocumentRow; upload: UploadTarget | null; replayed: boolean }>;
  putUpload(upload: UploadTarget, file: Blob, contentType: string): Promise<void>;
  markUploaded(caseId: string, documentId: string, expectedVersion: number): Promise<DocumentRow>;
  downloadDocument(caseId: string, documentId: string): Promise<{ url: string; expires_in_seconds: number }>;
  reviewDocument(caseId: string, documentId: string, body: { expected_version: number; decision: "APPROVED" | "REJECTED"; note?: string }): Promise<DocumentRow>;
  custody(caseId: string): Promise<CustodyPage>;
  recordCustody(caseId: string, body: CustodyInput): Promise<{ event: CustodyPage["events"][number]; current_custodian: CustodyPage["current_custodian"]; replayed: boolean }>;
  international(caseId: string): Promise<InternationalView>;
  approveRelease(caseId: string, body: { expected_version: number; acknowledge: string; note?: string }): Promise<{ record: InternationalView["record"]; legal_clearance: boolean }>;
  billing(caseId: string): Promise<{ quotes: Quote[]; invoices: Invoice[] }>;
  integrationEvents(caseId: string): Promise<IntegrationEvent[]>;
  history(caseId: string): Promise<HistoryRow[]>;
  restricted(caseId: string): Promise<RestrictedRecord>;
  driverLegs(): Promise<BoardLeg[]>;
  driverCustody(legId: string): Promise<CustodyPage>;
  driverRecordCustody(legId: string, body: CustodyInput): Promise<{ event: CustodyPage["events"][number]; current_custodian: CustodyPage["current_custodian"]; replayed: boolean }>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createHttpMortuaryClient(options: {
  baseUrl?: string;
  token: () => Promise<string>;
  fetchImpl?: FetchLike;
}): MortuaryClient {
  const base = (options.baseUrl ?? (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
    let response: Response;
    try {
      const token = await options.token();
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      throw new MortuaryError(0, `The mortuary API could not be reached. Sample records were not substituted. ${error instanceof Error ? error.message : ""}`.trim(), "UNAVAILABLE");
    }
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string; problems?: string[] };
    if (!response.ok) {
      throw new MortuaryError(response.status, data.error || `Request failed (${response.status})`, data.code ?? null, Array.isArray(data.problems) ? data.problems : []);
    }
    return { status: response.status, data: data as T };
  }

  function queryString(query: CaseListQuery = {}): string {
    const params = new URLSearchParams();
    for (const status of query.status ?? []) params.append("status", status);
    if (query.serviceType) params.set("service_type", query.serviceType);
    if (query.coordinatorMemberId) params.set("coordinator_member_id", query.coordinatorMemberId);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  return {
    source: "http",
    live: true,
    async listCases(query) {
      const { data } = await request<{ cases: MortuaryCase[]; next_cursor: string | null }>(`/mortuary/cases${queryString(query)}`);
      return { cases: data.cases ?? [], next_cursor: data.next_cursor ?? null };
    },
    async getCase(id) {
      const { data } = await request<CaseDetail>(`/mortuary/cases/${id}`);
      return data;
    },
    async createCase(input) {
      const { status, data } = await request<{ case: MortuaryCase; replayed?: boolean }>("/mortuary/cases", { method: "POST", body: input });
      return { case: data.case, replayed: status === 200 || Boolean(data.replayed) };
    },
    async listLegs(caseId) {
      const { data } = await request<{ legs: Leg[] }>(`/mortuary/cases/${caseId}/legs`);
      return data.legs ?? [];
    },
    async dispatchBoard(from, to) {
      const params = new URLSearchParams({ from, to });
      const { data } = await request<{ legs: BoardLeg[] }>(`/mortuary/dispatch/board?${params}`);
      return data.legs ?? [];
    },
    async assignLeg(caseId, legId, body) {
      const { data } = await request<{ leg: Leg }>(`/mortuary/cases/${caseId}/legs/${legId}/assignment`, { method: "POST", body });
      return data.leg;
    },
    async checklist(caseId) {
      const { data } = await request<Checklist>(`/mortuary/cases/${caseId}/checklist`);
      return data;
    },
    async documents(caseId) {
      const { data } = await request<{ documents: DocumentRow[] }>(`/mortuary/cases/${caseId}/documents`);
      return data.documents ?? [];
    },
    async createDocument(caseId, body) {
      const { status, data } = await request<{ document: DocumentRow; upload: UploadTarget | null; replayed?: boolean }>(`/mortuary/cases/${caseId}/documents`, { method: "POST", body });
      return { document: data.document, upload: data.upload ?? null, replayed: status === 200 || Boolean(data.replayed) };
    },
    async putUpload(upload, file, contentType) {
      const response = await fetchImpl(upload.signed_url, {
        method: "PUT",
        headers: { "content-type": contentType, authorization: `Bearer ${upload.token}` },
        body: file,
      });
      if (!response.ok) throw new MortuaryError(response.status, "The file was not stored. The document stays pending until storage accepts it.", "STORAGE_UNAVAILABLE");
    },
    async markUploaded(caseId, documentId, expectedVersion) {
      const { data } = await request<{ document: DocumentRow }>(`/mortuary/cases/${caseId}/documents/${documentId}/uploaded`, { method: "POST", body: { expected_version: expectedVersion } });
      return data.document;
    },
    async downloadDocument(caseId, documentId) {
      const { data } = await request<{ url: string; expires_in_seconds: number }>(`/mortuary/cases/${caseId}/documents/${documentId}/download-url`, { method: "POST" });
      return data;
    },
    async reviewDocument(caseId, documentId, body) {
      const { data } = await request<{ document: DocumentRow }>(`/mortuary/cases/${caseId}/documents/${documentId}/review`, { method: "POST", body });
      return data.document;
    },
    async custody(caseId) {
      const { data } = await request<CustodyPage>(`/mortuary/cases/${caseId}/custody-events?after_seq=0&limit=200`);
      return data;
    },
    async recordCustody(caseId, body) {
      const { status, data } = await request<{ event: CustodyPage["events"][number]; current_custodian: CustodyPage["current_custodian"]; replayed?: boolean }>(`/mortuary/cases/${caseId}/custody-events`, { method: "POST", body });
      return { ...data, replayed: status === 200 || Boolean(data.replayed) };
    },
    async international(caseId) {
      const { data } = await request<InternationalView>(`/mortuary/cases/${caseId}/international`);
      return data;
    },
    async approveRelease(caseId, body) {
      const { data } = await request<{ record: InternationalView["record"]; legal_clearance: boolean }>(`/mortuary/cases/${caseId}/international/release-approval`, { method: "POST", body });
      return data;
    },
    async billing(caseId) {
      const { data } = await request<{ quotes: Quote[]; invoices: Invoice[] }>(`/mortuary/cases/${caseId}/billing`);
      return { quotes: data.quotes ?? [], invoices: data.invoices ?? [] };
    },
    async integrationEvents(caseId) {
      const { data } = await request<{ events: IntegrationEvent[] }>(`/mortuary/cases/${caseId}/integration-events`);
      return data.events ?? [];
    },
    async history(caseId) {
      const { data } = await request<{ history: HistoryRow[] }>(`/mortuary/cases/${caseId}/history`);
      return data.history ?? [];
    },
    async restricted(caseId) {
      const { data } = await request<{ record: RestrictedRecord }>(`/mortuary/cases/${caseId}/restricted`);
      return data.record;
    },
    async driverLegs() {
      const { data } = await request<{ legs: BoardLeg[] }>("/driver/mortuary/legs");
      return data.legs ?? [];
    },
    async driverCustody(legId) {
      const { data } = await request<CustodyPage>(`/driver/mortuary/legs/${legId}/custody-events`);
      return data;
    },
    async driverRecordCustody(legId, body) {
      const { status, data } = await request<{ event: CustodyPage["events"][number]; current_custodian: CustodyPage["current_custodian"]; replayed?: boolean }>(`/driver/mortuary/legs/${legId}/custody-events`, { method: "POST", body });
      return { ...data, replayed: status === 200 || Boolean(data.replayed) };
    },
  };
}

export function httpMortuaryClient(token: () => Promise<string>): MortuaryClient {
  return createHttpMortuaryClient({ token });
}
