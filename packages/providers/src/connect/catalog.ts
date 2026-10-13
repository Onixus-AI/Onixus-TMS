import { webhookAutomation, type Automation } from "../automation/webhook.js";
import { googleCalendar, type Calendar } from "../calendar/google.js";
import { slack, type Chat } from "../chat/slack.js";
import { googleDrive, googleSheets, type Documents, type Sheet } from "../google/workspace.js";
import { fetchJson, missingVars, type Env } from "../env.js";
import { claude } from "../llm/claude.js";
import { openAiCompatible } from "../llm/openai.js";
import { openrouter } from "../llm/openrouter.js";
import { hubspot } from "../crm/hubspot.js";
import { gmail } from "../email/gmail.js";
import { microsoft } from "../email/microsoft.js";
import { quickbooks } from "../finance/quickbooks.js";
import { motive } from "../tracking/motive.js";
import { samsara } from "../tracking/samsara.js";
import { traccar } from "../tracking/traccar.js";
import { ProviderError, type CrmProvider, type EmailProvider, type FinanceProvider, type LlmProvider, type TrackingProvider } from "../types.js";

// What each company can connect, by category, and how. A connection is the
// company's own account: its mailbox sends its emails, its CRM gets its
// customers, its books get its invoices, its trackers show its trucks, its
// AI key powers the assistant and drafts, its automations hear about loads
// and invoices, and its calendar gets its appointments.
//  - oauth: the company signs in at the provider; Onixus's app (client id and
//    secret in the API's environment) receives a refresh token.
//  - fields: the company pastes an API key or server login.
//  - soon: listed, not connectable yet (Veltra products, until their APIs land).

export const CATEGORIES = ["email", "crm", "finance", "tracking", "ai", "automation", "chat", "calendar", "documents", "reports"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Credentials = Record<string, string>;
export type Field = { name: string; label: string; secret?: boolean; placeholder?: string; optional?: boolean; pattern?: string; hint?: string };
export type Built = { email: EmailProvider; crm: CrmProvider; finance: FinanceProvider; tracking: TrackingProvider; ai: LlmProvider; automation: Automation; chat: Chat; calendar: Calendar; documents: Documents; reports: Sheet };
type Hooks = { onRotate?: (refreshToken: string) => void };

export type OAuthSpec = {
  clientIdVar: string;
  clientSecretVar: string;
  authorizeUrl: string;
  tokenUrlVar?: string;
  tokenUrl: string;
  scope: string;
  params?: Record<string, string>;
  /** Intuit wants the client credentials as HTTP Basic auth. */
  basic?: boolean;
  /** From the token response (and the callback's query) to stored credentials and a label for the account. */
  identify: (tokens: TokenSet, query: Record<string, string>) => { credentials: Credentials; account: string };
};
export type TokenSet = { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };

export type Connector<C extends Category = Category> = {
  id: string;
  category: C;
  label: string;
  by?: "Onixus";
  blurb: string;
  method: "oauth" | "fields" | "soon";
  fields?: Field[];
  oauth?: OAuthSpec;
  /** A working provider from the company's credentials (and the platform's app credentials in env). */
  build?: (env: Env, creds: Credentials, hooks?: Hooks) => Built[C];
};

/** The claims of an id_token from the provider's own token endpoint (fetched over TLS, so not re-verified). */
const idClaims = (t: TokenSet): Record<string, string> => {
  try {
    return t.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) : {};
  } catch {
    return {};
  }
};

/** Google sign-in for Drive and Sheets: drive.file only sees what Onixus itself creates. */
function googleWorkspace(label: string): OAuthSpec {
  return {
    clientIdVar: "GMAIL_CLIENT_ID", clientSecretVar: "GMAIL_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrlVar: "GOOGLE_TOKEN_URL", tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/drive.file", params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    identify: (t) => {
      const email = idClaims(t).email ?? "";
      return { credentials: { refresh_token: t.refresh_token ?? "" }, account: email || label };
    },
  };
}
const workspaceOpts = (env: Env, c: Credentials, hooks?: Hooks) => ({
  clientId: env.GMAIL_CLIENT_ID!.trim(), clientSecret: env.GMAIL_CLIENT_SECRET!.trim(), refreshToken: c.refresh_token!, onRotate: hooks?.onRotate,
  tokenUrl: env.GOOGLE_TOKEN_URL?.trim() || undefined, driveUrl: env.GOOGLE_DRIVE_API_URL?.trim() || undefined, uploadUrl: env.GOOGLE_UPLOAD_API_URL?.trim() || undefined, sheetsUrl: env.GOOGLE_SHEETS_API_URL?.trim() || undefined,
});

export const CONNECTORS: Connector[] = [
  {
    id: "gmail", category: "email", label: "Gmail", blurb: "Send customer emails and invoices from your Google Workspace or Gmail address.", method: "oauth",
    oauth: {
      clientIdVar: "GMAIL_CLIENT_ID", clientSecretVar: "GMAIL_CLIENT_SECRET",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrlVar: "GOOGLE_TOKEN_URL", tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email https://www.googleapis.com/auth/gmail.send", params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      identify: (t) => {
        const email = idClaims(t).email ?? "";
        return { credentials: { refresh_token: t.refresh_token ?? "", email }, account: email || "Gmail" };
      },
    },
    build: (env, c, hooks) => gmail({ ...env, GMAIL_REFRESH_TOKEN: c.refresh_token, GMAIL_SENDER: c.email }, hooks),
  },
  {
    id: "outlook", category: "email", label: "Outlook", blurb: "Send from your Microsoft 365, Outlook.com or Exchange Online mailbox.", method: "oauth",
    oauth: {
      clientIdVar: "MS_CLIENT_ID", clientSecretVar: "MS_CLIENT_SECRET",
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrlVar: "MS_TOKEN_URL", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scope: "openid email offline_access User.Read Mail.Send", params: { response_mode: "query", prompt: "select_account" },
      identify: (t) => {
        const c = idClaims(t);
        const email = c.email ?? c.preferred_username ?? "";
        return { credentials: { refresh_token: t.refresh_token ?? "", email }, account: email || "Outlook" };
      },
    },
    build: (env, c, hooks) => microsoft({ ...env, MS_REFRESH_TOKEN: c.refresh_token, MS_SCOPE: "offline_access Mail.Send User.Read" }, hooks),
  },
  { id: "veltra", category: "email", label: "Veltra", by: "Onixus", blurb: "The AI email employee: cleans the inbox, answers, quotes within your rate floor, files DOs and BOLs into Onixus, follows up.", method: "soon" },

  {
    id: "hubspot", category: "crm", label: "HubSpot", blurb: "New customers are added to HubSpot as companies; sync existing ones with a click.", method: "fields",
    fields: [{ name: "token", label: "Private app access token", secret: true, placeholder: "pat-na1-…" }],
    build: (env, c) => hubspot({ ...env, HUBSPOT_ACCESS_TOKEN: c.token }),
  },
  { id: "veltra-crm", category: "crm", label: "Veltra CRM", by: "Onixus", blurb: "Onixus's own CRM for shippers, brokers and lines.", method: "soon" },

  {
    id: "quickbooks", category: "finance", label: "QuickBooks Online", blurb: "Send invoices to QuickBooks for the same customer, line by line.", method: "oauth",
    oauth: {
      clientIdVar: "QBO_CLIENT_ID", clientSecretVar: "QBO_CLIENT_SECRET",
      authorizeUrl: "https://appcenter.intuit.com/connect/oauth2", tokenUrlVar: "QBO_TOKEN_URL", tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      scope: "com.intuit.quickbooks.accounting", basic: true,
      identify: (t, q) => ({ credentials: { refresh_token: t.refresh_token ?? "", realm_id: q.realmId ?? "" }, account: q.realmId ? `Company ${q.realmId}` : "QuickBooks" }),
    },
    build: (env, c, hooks) => quickbooks({ ...env, QBO_REFRESH_TOKEN: c.refresh_token, QBO_REALM_ID: c.realm_id }, hooks),
  },
  { id: "veltrafi", category: "finance", label: "VeltraFi", by: "Onixus", blurb: "Onixus's own finance: invoicing, factoring and payouts.", method: "soon" },

  {
    id: "openai", category: "ai", label: "OpenAI", blurb: "Your OpenAI key powers the assistant and email drafts (GPT models).", method: "fields",
    fields: [{ name: "api_key", label: "API key", secret: true, placeholder: "sk-…" }, { name: "model", label: "Model", optional: true, placeholder: "gpt-5 (default)" }],
    build: (_env, c) => openAiCompatible({ name: "openai", label: "OpenAI", apiKey: c.api_key!, model: c.model || "gpt-5" }),
  },
  {
    id: "anthropic", category: "ai", label: "Claude", blurb: "Your Anthropic key powers the assistant and email drafts (Claude models).", method: "fields",
    fields: [{ name: "api_key", label: "API key", secret: true, placeholder: "sk-ant-…" }, { name: "model", label: "Model", optional: true, placeholder: "claude-opus-5-5 (default)" }],
    build: (_env, c) => claude({ ANTHROPIC_API_KEY: c.api_key, CLAUDE_MODEL: c.model }),
  },
  {
    id: "gemini", category: "ai", label: "Gemini", blurb: "Your Google AI Studio key powers the assistant and email drafts (Gemini models).", method: "fields",
    fields: [{ name: "api_key", label: "API key", secret: true, placeholder: "AIza…" }, { name: "model", label: "Model", optional: true, placeholder: "gemini-2.5-flash (default)" }],
    build: (_env, c) => openAiCompatible({ name: "gemini", label: "Gemini", apiKey: c.api_key!, model: c.model || "gemini-2.5-flash", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
  },
  {
    id: "openrouter", category: "ai", label: "OpenRouter", blurb: "One key for DeepSeek, Qwen, Llama, Mistral and hundreds more.", method: "fields",
    fields: [{ name: "api_key", label: "API key", secret: true, placeholder: "sk-or-…" }, { name: "model", label: "Model", optional: true, placeholder: "google/gemini-2.5-flash (default)" }],
    build: (env, c) => openrouter({ OPENROUTER_API_KEY: c.api_key, OPENROUTER_MODEL: c.model, OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL }),
  },

  {
    id: "zapier", category: "automation", label: "Zapier", blurb: "Start a Zap when a load is booked, delivered or invoiced (Webhooks by Zapier → Catch Hook).", method: "fields",
    fields: [{ name: "url", label: "Catch Hook URL", placeholder: "https://hooks.zapier.com/hooks/catch/…", pattern: "^https://hooks\\.zapier\\.com/hooks/catch/", hint: "Use the Catch Hook URL from Webhooks by Zapier" }],
    build: (_env, c) => webhookAutomation("zapier", c.url!),
  },
  {
    id: "make", category: "automation", label: "Make", blurb: "Run a Make scenario on load and invoice events (Webhooks → Custom webhook).", method: "fields",
    fields: [{ name: "url", label: "Webhook URL", placeholder: "https://hook.us1.make.com/…", pattern: "^https://hook\\.[a-z0-9-]+\\.make\\.com/", hint: "Use the custom webhook URL from Make" }],
    build: (_env, c) => webhookAutomation("make", c.url!),
  },
  {
    id: "n8n", category: "automation", label: "n8n", blurb: "Trigger an n8n workflow (Webhook node, POST) on load and invoice events.", method: "fields",
    fields: [{ name: "url", label: "Webhook URL", placeholder: "https://your-n8n.example.com/webhook/…" }],
    build: (_env, c) => webhookAutomation("n8n", c.url!),
  },

  {
    id: "google-calendar", category: "calendar", label: "Google Calendar", blurb: "Terminal and customer appointments appear on your calendar, and move when they change.", method: "oauth",
    oauth: {
      clientIdVar: "GMAIL_CLIENT_ID", clientSecretVar: "GMAIL_CLIENT_SECRET",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrlVar: "GOOGLE_TOKEN_URL", tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly", params: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      identify: (t) => {
        const email = idClaims(t).email ?? "";
        return { credentials: { refresh_token: t.refresh_token ?? "" }, account: email || "Google Calendar" };
      },
    },
    build: (env, c, hooks) => googleCalendar({ clientId: env.GMAIL_CLIENT_ID!.trim(), clientSecret: env.GMAIL_CLIENT_SECRET!.trim(), refreshToken: c.refresh_token!, tokenUrl: env.GOOGLE_TOKEN_URL?.trim() || undefined, apiUrl: env.GOOGLE_CALENDAR_API_URL?.trim() || undefined, onRotate: hooks?.onRotate }),
  },
  { id: "outlook-calendar", category: "calendar", label: "Outlook Calendar", blurb: "Appointments on your Microsoft 365 calendar.", method: "soon" },
  { id: "google-meet", category: "calendar", label: "Google Meet", blurb: "A Meet link on customer calls and driver check-ins.", method: "soon" },

  {
    id: "slack", category: "chat", label: "Slack", blurb: "Loads booked, delivered and invoiced, posted in your channel (Slack app → Incoming Webhooks).", method: "fields",
    fields: [{ name: "url", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…", pattern: "^https://hooks\\.slack\\.com/services/", hint: "Use the incoming-webhook URL from your Slack app" }],
    build: (_env, c) => slack(c.url!),
  },
  { id: "microsoft-teams", category: "chat", label: "Microsoft Teams", blurb: "The same updates in a Teams channel.", method: "soon" },

  {
    id: "google-drive", category: "documents", label: "Google Drive", blurb: "Every BOL, POD and delivery order uploaded on a load is also saved to an “Onixus Logistics OS” folder.", method: "oauth",
    oauth: { ...googleWorkspace("Google Drive") },
    build: (env, c, hooks) => googleDrive(workspaceOpts(env, c, hooks)),
  },
  { id: "google-docs", category: "documents", label: "Google Docs", blurb: "Rate confirmations and contracts written as Google Docs.", method: "soon" },

  {
    id: "google-sheets", category: "reports", label: "Google Sheets", blurb: "A live “Load log” spreadsheet: a row for every load booked, moved, delivered and invoiced.", method: "oauth",
    oauth: { ...googleWorkspace("Google Sheets") },
    build: (env, c, hooks) => googleSheets(workspaceOpts(env, c, hooks)),
  },

  {
    id: "samsara", category: "tracking", label: "Samsara", blurb: "Live positions of your Samsara-equipped trucks.", method: "fields",
    fields: [{ name: "token", label: "API token", secret: true, placeholder: "samsara_api_…" }],
    build: (env, c) => samsara({ ...env, SAMSARA_API_TOKEN: c.token }),
  },
  {
    id: "motive", category: "tracking", label: "Motive", blurb: "Live positions from Motive (KeepTruckin) ELDs.", method: "fields",
    fields: [{ name: "token", label: "API key", secret: true }],
    build: (env, c) => motive({ ...env, MOTIVE_API_KEY: c.token }),
  },
  {
    id: "traccar", category: "tracking", label: "Traccar", blurb: "Open-source GPS: the free Traccar phone app or any hardware tracker.", method: "fields",
    fields: [{ name: "url", label: "Server URL", placeholder: "https://gps.yourcompany.com" }, { name: "token", label: "API token", secret: true }],
    build: (env, c) => traccar({ ...env, TRACCAR_URL: c.url, TRACCAR_TOKEN: c.token }),
  },
];

export const connector = (id: string) => CONNECTORS.find((c) => c.id === id);

/** Whether Onixus's own app credentials for an OAuth provider are in place; without them the company can't start. */
export function oauthReady(env: Env, c: Connector): { ready: boolean; missing: string[] } {
  if (c.method !== "oauth" || !c.oauth) return { ready: c.method === "fields", missing: [] };
  const missing = missingVars(env, [c.oauth.clientIdVar, c.oauth.clientSecretVar]);
  return { ready: missing.length === 0, missing };
}

export function authorizeUrl(env: Env, c: Connector, redirectUri: string, state: string): string {
  const o = c.oauth!;
  const q = new URLSearchParams({ client_id: env[o.clientIdVar]!.trim(), redirect_uri: redirectUri, response_type: "code", scope: o.scope, state, ...o.params });
  return `${o.authorizeUrl}?${q}`;
}

export async function exchangeCode(env: Env, c: Connector, code: string, redirectUri: string): Promise<TokenSet> {
  const o = c.oauth!;
  const id = env[o.clientIdVar]!.trim(), secret = env[o.clientSecretVar]!.trim();
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, ...(o.basic ? {} : { client_id: id, client_secret: secret }) });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (o.basic) headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  const t = await fetchJson<TokenSet>((o.tokenUrlVar && env[o.tokenUrlVar]?.trim()) || o.tokenUrl, { method: "POST", headers, body }, (s, text) => new ProviderError(`${c.label} sign-in`, s, text));
  if (!t.refresh_token) throw new ProviderError(`${c.label} sign-in`, 400, "no refresh token came back; remove Onixus's access in your account settings and connect again");
  return t;
}
