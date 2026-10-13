// Provider contracts. Each capability (email, CRM, LLM, database, GPS) has one
// interface and several interchangeable implementations, chosen per
// deployment by environment variables (see registry.ts).

export type ProviderStatus = {
  capability: "email" | "crm" | "llm" | "database" | "tracking";
  provider: string;
  /** false when the provider is a planned one (Onyx) that has no implementation yet. */
  available: boolean;
  /** true when every environment variable the provider needs is set. */
  configured: boolean;
  missing: string[];
};

export type EmailMessage = {
  id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  receivedAt: string;
};

export type SendEmail = {
  to: string;
  subject: string;
  html: string;
  /** Optional reply-to address; the sender is always the connected mailbox. */
  replyTo?: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: SendEmail): Promise<{ id: string }>;
  listUnread(limit: number): Promise<EmailMessage[]>;
}

export type CrmCompany = {
  id: string;
  name: string;
  domain?: string;
  /** SHIPPER, MANUFACTURER, BROKER, … stored in the CRM's own field. */
  type?: string;
};

export type NewCrmCompany = { name: string; domain?: string; type?: string; phone?: string };
export type NewCrmContact = { email: string; firstName?: string; lastName?: string; phone?: string; companyId?: string };

export interface CrmProvider {
  readonly name: string;
  searchCompanies(query: string, limit: number): Promise<CrmCompany[]>;
  createCompany(company: NewCrmCompany): Promise<CrmCompany>;
  createContact(contact: NewCrmContact): Promise<{ id: string }>;
}

export type Completion = { system?: string; prompt: string; maxTokens?: number };

/** Read a document (PDF or photo) and/or text into JSON matching a JSON Schema. */
export type Extraction = {
  system: string;
  text?: string;
  file?: { base64: string; mediaType: string };
  schema: Record<string, unknown>;
  maxTokens?: number;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: Completion): Promise<{ text: string; model: string }>;
  /** Structured extraction from documents; providers without it cannot read files. */
  extractJson?(request: Extraction): Promise<unknown>;
}

export type VehiclePosition = {
  /** The tracker's unique id; matches trucks.tracking_device_id. */
  deviceId: string;
  name: string;
  lat: number;
  lng: number;
  speedMph: number;
  heading: number;
  at: string;
};

export interface TrackingProvider {
  readonly name: string;
  positions(): Promise<VehiclePosition[]>;
}

/** Thrown for a provider that is planned but not built yet (Onyx Mail, Onyx CRM, Samsara, Motive). */
export class NotImplementedError extends Error {
  readonly status = 501;
  constructor(what: string) {
    super(`${what} is coming soon and is not available yet`);
  }
}

/** Thrown when a provider is selected but its credentials are missing. */
export class NotConfiguredError extends Error {
  readonly status = 503;
  constructor(provider: string, readonly missing: string[]) {
    super(`${provider} is not configured: set ${missing.join(", ")}`);
  }
}

/** Thrown when an upstream API (Gmail, Graph, HubSpot, …) rejects a call. */
export class ProviderError extends Error {
  readonly status = 502;
  constructor(provider: string, readonly upstreamStatus: number, detail: string) {
    super(`${provider} returned ${upstreamStatus}: ${detail.slice(0, 300)}`);
  }
}
