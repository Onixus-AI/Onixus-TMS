import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError, type EmailMessage, type EmailProvider } from "../types.js";
import { RefreshTokenAuth } from "./oauth.js";

// Microsoft Graph covers Outlook.com, Hotmail/Live and Microsoft 365 / Exchange
// Online mailboxes through the same API; MS_TENANT_ID picks the account type
// ("common" for personal Outlook + work accounts, or a tenant id for one org).
export const MICROSOFT_VARS = ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_REFRESH_TOKEN"] as const;
const API = "https://graph.microsoft.com/v1.0/me";

type GraphMessage = {
  id: string;
  subject: string | null;
  bodyPreview: string;
  receivedDateTime: string;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients: { emailAddress: { address: string } }[];
};

export function microsoft(env: Env, opts: { onRotate?: (refreshToken: string) => void } = {}): EmailProvider {
  const v = requireVars(env, "Microsoft / Outlook", [...MICROSOFT_VARS]);
  const tenant = env.MS_TENANT_ID?.trim() || "common";
  const auth = new RefreshTokenAuth(
    "Microsoft",
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    { client_id: v.MS_CLIENT_ID, client_secret: v.MS_CLIENT_SECRET, scope: env.MS_SCOPE?.trim() || "offline_access Mail.Read Mail.Send" },
    v.MS_REFRESH_TOKEN,
    opts,
  );
  const call = async <T>(path: string, init: RequestInit = {}) =>
    fetchJson<T>(
      `${API}${path}`,
      { ...init, headers: { Authorization: `Bearer ${await auth.token()}`, "Content-Type": "application/json" } },
      (status, text) => new ProviderError("Microsoft Graph", status, text),
    );

  return {
    name: "microsoft",
    async send(m) {
      // sendMail answers 202 Accepted with no message id.
      await call("/sendMail", {
        method: "POST",
        body: JSON.stringify({
          message: {
            subject: m.subject,
            body: { contentType: "HTML", content: m.html },
            toRecipients: [{ emailAddress: { address: m.to } }],
            ...(m.replyTo ? { replyTo: [{ emailAddress: { address: m.replyTo } }] } : {}),
          },
          saveToSentItems: true,
        }),
      });
      return { id: "" };
    },
    async listUnread(limit) {
      const r = await call<{ value: GraphMessage[] }>(
        `/mailFolders/inbox/messages?$filter=isRead eq false&$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,receivedDateTime,from,toRecipients`,
      );
      return r.value.map(
        (m): EmailMessage => ({
          id: m.id,
          from: m.from?.emailAddress.address ?? "",
          to: m.toRecipients.map((t) => t.emailAddress.address).join(", "),
          subject: m.subject ?? "",
          snippet: m.bodyPreview,
          receivedAt: m.receivedDateTime,
        }),
      );
    },
  };
}
