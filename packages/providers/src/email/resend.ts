import { fetchJson, requireVars, type Env } from "../env.js";
import { NotImplementedError, ProviderError, type EmailProvider } from "../types.js";
import { headerSafe } from "./oauth.js";

// Resend: sending only, from a domain verified in Resend (one API key, a few
// DNS records, 3,000 emails a month free). Companies' emails go out from the
// Onixus address under the company's name, with replies to the dispatcher.
export const RESEND_VARS = ["RESEND_API_KEY", "RESEND_FROM"] as const;

/** `Name <address>` with the name reduced to characters a From header accepts. */
export function fromWithName(from: string, name?: string): string {
  if (!name) return from;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  return `${headerSafe(name).replace(/["<>\\]/g, "")} <${address}>`;
}

export function resend(env: Env): EmailProvider {
  const v = requireVars(env, "Resend", [...RESEND_VARS]);
  const base = env.RESEND_BASE_URL?.trim() || "https://api.resend.com";
  return {
    name: "resend",
    async send(m) {
      const r = await fetchJson<{ id: string }>(
        `${base}/emails`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${v.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromWithName(v.RESEND_FROM, m.fromName), to: [m.to], subject: headerSafe(m.subject), html: m.html, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
        },
        (status, text) => new ProviderError("Resend", status, text),
      );
      return { id: r.id };
    },
    async listUnread() {
      throw new NotImplementedError("Reading an inbox through Resend");
    },
  };
}
