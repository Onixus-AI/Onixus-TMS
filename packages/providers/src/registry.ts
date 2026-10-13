import { missingVars, type Env } from "./env.js";
import { gmail, GMAIL_VARS } from "./email/gmail.js";
import { microsoft, MICROSOFT_VARS } from "./email/microsoft.js";
import { resend, RESEND_VARS } from "./email/resend.js";
import { hubspot, HUBSPOT_VARS } from "./crm/hubspot.js";
import { claude, CLAUDE_VARS } from "./llm/claude.js";
import { openai, OPENAI_VARS } from "./llm/openai.js";
import { onyxLlm, ONYX_LLM_VARS } from "./llm/onyx.js";
import { openrouter, OPENROUTER_VARS } from "./llm/openrouter.js";
import { SUPABASE_VARS } from "./db/supabase.js";
import { traccar, TRACCAR_VARS } from "./tracking/traccar.js";
import { NotImplementedError, type CrmProvider, type EmailProvider, type LlmProvider, type ProviderStatus, type TrackingProvider } from "./types.js";

type Capability = ProviderStatus["capability"];
type Entry<T> = { vars: readonly string[]; make?: (env: Env) => T; label: string };

// Which providers each capability supports. An entry without `make` is
// planned (Veltra, Onyx CRM, Samsara, Motive): selectable, reported as "coming soon",
// and every call answers 501 instead of pretending to succeed.
export const EMAIL_PROVIDERS: Record<string, Entry<EmailProvider>> = {
  gmail: { label: "Gmail", vars: GMAIL_VARS, make: gmail },
  microsoft: { label: "Microsoft 365 / Outlook", vars: MICROSOFT_VARS, make: microsoft },
  resend: { label: "Resend", vars: RESEND_VARS, make: resend },
  veltra: { label: "Veltra", vars: [] },
};
export const CRM_PROVIDERS: Record<string, Entry<CrmProvider>> = {
  hubspot: { label: "HubSpot", vars: HUBSPOT_VARS, make: hubspot },
  onyx: { label: "Onyx CRM", vars: [] },
};
export const LLM_PROVIDERS: Record<string, Entry<LlmProvider>> = {
  claude: { label: "Claude", vars: CLAUDE_VARS, make: claude },
  openai: { label: "OpenAI", vars: OPENAI_VARS, make: openai },
  onyx: { label: "Onyx", vars: ONYX_LLM_VARS, make: onyxLlm },
  openrouter: { label: "OpenRouter", vars: OPENROUTER_VARS, make: openrouter },
};
export const DATABASE_PROVIDERS: Record<string, Entry<never>> = {
  supabase: { label: "Supabase", vars: SUPABASE_VARS },
};

export const TRACKING_PROVIDERS: Record<string, Entry<TrackingProvider>> = {
  traccar: { label: "Traccar GPS", vars: TRACCAR_VARS, make: traccar },
  samsara: { label: "Samsara", vars: [] },
  motive: { label: "Motive", vars: [] },
};

const ALIASES: Record<string, string> = { outlook: "microsoft", office365: "microsoft", m365: "microsoft", anthropic: "claude" };

const TABLES: Record<Capability, { env: string; fallback: string; table: Record<string, Entry<unknown>> }> = {
  email: { env: "EMAIL_PROVIDER", fallback: "gmail", table: EMAIL_PROVIDERS },
  crm: { env: "CRM_PROVIDER", fallback: "hubspot", table: CRM_PROVIDERS },
  llm: { env: "LLM_PROVIDER", fallback: "claude", table: LLM_PROVIDERS },
  database: { env: "DATABASE_PROVIDER", fallback: "supabase", table: DATABASE_PROVIDERS },
  tracking: { env: "TRACKING_PROVIDER", fallback: "traccar", table: TRACKING_PROVIDERS },
};

/** The provider key chosen for a capability, validated against what exists. */
export function selected(capability: Capability, env: Env): string {
  const t = TABLES[capability];
  const raw = (env[t.env] ?? t.fallback).trim().toLowerCase();
  // Veltra was called Onyx Mail: an EMAIL_PROVIDER=onyx set before the rename keeps working.
  const key = capability === "email" && raw === "onyx" ? "veltra" : ALIASES[raw] ?? raw;
  if (!t.table[key]) throw new Error(`${t.env}=${raw} is not supported; choose one of: ${Object.keys(t.table).join(", ")}`);
  return key;
}

export function providerStatus(env: Env): ProviderStatus[] {
  return (Object.keys(TABLES) as Capability[]).map((capability) => {
    const key = selected(capability, env);
    const entry = TABLES[capability].table[key];
    const available = capability === "database" || Boolean(entry.make);
    const missing = available ? missingVars(env, [...entry.vars]) : [];
    return { capability, provider: entry.label, available, configured: available && missing.length === 0, missing };
  });
}

function build<T>(capability: Capability, env: Env): T {
  const entry = TABLES[capability].table[selected(capability, env)] as Entry<T>;
  if (!entry.make) throw new NotImplementedError(entry.label);
  return entry.make(env);
}

export const emailProvider = (env: Env) => build<EmailProvider>("email", env);
export const crmProvider = (env: Env) => build<CrmProvider>("crm", env);
export const llmProvider = (env: Env) => build<LlmProvider>("llm", env);
export const trackingProvider = (env: Env) => build<TrackingProvider>("tracking", env);
