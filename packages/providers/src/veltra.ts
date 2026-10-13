import { fetchJson, type Env } from "./env.js";
import { ProviderError } from "./types.js";

// Veltra, Onixus's AI email employee, runs as its own service. Linking a
// company hands the Veltra account signed in with the same email a key that
// works only inside that company; Veltra then reads its delivery orders into
// loads, files BOLs and PODs, and quotes from the company's own rates.

export type VeltraAccount = { id: string; name: string; mailbox: string | null; onixus_org: string | null };

export const VELTRA_VARS = ["VELTRA_URL", "VELTRA_API_KEY"] as const;

export function veltra(env: Env) {
  const base = (env.VELTRA_URL ?? "").trim().replace(/\/$/, "");
  const call = <T>(path: string, method: string, body?: unknown) =>
    fetchJson<T>(`${base}/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${(env.VELTRA_API_KEY ?? "").trim()}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 60_000,
    }, (s, t) => new ProviderError("Veltra", s, (() => { try { return (JSON.parse(t) as { error?: string }).error ?? t; } catch { return t; } })()));
  return {
    url: base,
    /** Give the Veltra account signed in with `email` this company's key. */
    link: (p: { email: string; api_url: string; api_key: string; org_id: string }) => call<{ account: VeltraAccount }>("/packs/onixus", "PUT", p).then((r) => r.account),
    /** Take the key back, unless the account has since been linked to another company. */
    unlink: (accountId: string, orgId: string) => call<{ account: VeltraAccount }>(`/accounts/${encodeURIComponent(accountId)}/packs/onixus?org_id=${encodeURIComponent(orgId)}`, "DELETE"),
    account: (accountId: string) => call<{ account: VeltraAccount }>(`/accounts/${encodeURIComponent(accountId)}`, "GET").then((r) => r.account),
  };
}
