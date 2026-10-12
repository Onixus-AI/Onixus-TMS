import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError, type EmailMessage, type EmailProvider, type SendEmail } from "../types.js";
import { headerSafe, RefreshTokenAuth } from "./oauth.js";

export const GMAIL_VARS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_SENDER"] as const;
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** RFC 2822 message, base64url-encoded as the Gmail API requires. */
export function gmailRaw(from: string, m: SendEmail): string {
  const subject = `=?UTF-8?B?${Buffer.from(headerSafe(m.subject)).toString("base64")}?=`;
  const lines = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(m.to)}`,
    ...(m.replyTo ? [`Reply-To: ${headerSafe(m.replyTo)}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.html).toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

type GmailList = { messages?: { id: string }[] };
type GmailMessage = {
  id: string;
  snippet: string;
  internalDate: string;
  payload: { headers: { name: string; value: string }[] };
};

export function gmail(env: Env): EmailProvider {
  const v = requireVars(env, "Gmail", [...GMAIL_VARS]);
  const auth = new RefreshTokenAuth(
    "Gmail",
    "https://oauth2.googleapis.com/token",
    { client_id: v.GMAIL_CLIENT_ID, client_secret: v.GMAIL_CLIENT_SECRET },
    v.GMAIL_REFRESH_TOKEN,
  );
  const call = async <T>(path: string, init: RequestInit = {}) =>
    fetchJson<T>(
      `${API}${path}`,
      { ...init, headers: { Authorization: `Bearer ${await auth.token()}`, "Content-Type": "application/json" } },
      (status, text) => new ProviderError("Gmail", status, text),
    );

  return {
    name: "gmail",
    async send(m) {
      const r = await call<{ id: string }>("/messages/send", { method: "POST", body: JSON.stringify({ raw: gmailRaw(v.GMAIL_SENDER, m) }) });
      return { id: r.id };
    },
    async listUnread(limit) {
      const list = await call<GmailList>(`/messages?q=${encodeURIComponent("is:unread in:inbox")}&maxResults=${limit}`);
      const messages = await Promise.all(
        (list.messages ?? []).map((m) =>
          call<GmailMessage>(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`),
        ),
      );
      return messages.map((m): EmailMessage => {
        const h = (name: string) => m.payload.headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
        return { id: m.id, from: h("From"), to: h("To"), subject: h("Subject"), snippet: m.snippet, receivedAt: new Date(Number(m.internalDate)).toISOString() };
      });
    },
  };
}
