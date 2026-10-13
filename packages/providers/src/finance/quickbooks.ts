import { fetchJson, requireVars, type Env } from "../env.js";
import { RefreshTokenAuth } from "../email/oauth.js";
import { ProviderError, type FinanceInvoice, type FinanceProvider } from "../types.js";

// QuickBooks Online: invoices from Onixus become QuickBooks invoices for the
// same customer (found by name, or created), each line on the company's
// first service item. The company connects with Intuit's OAuth; Onixus keeps
// the refresh token and the company (realm) id.
export const QUICKBOOKS_VARS = ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REFRESH_TOKEN", "QBO_REALM_ID"] as const;
const MINOR = "minorversion=75";
const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function quickbooks(env: Env, opts: { onRotate?: (refreshToken: string) => void } = {}): FinanceProvider {
  const v = requireVars(env, "QuickBooks", [...QUICKBOOKS_VARS]);
  const base = `${(env.QBO_BASE_URL?.trim() || "https://quickbooks.api.intuit.com").replace(/\/$/, "")}/v3/company/${encodeURIComponent(v.QBO_REALM_ID)}`;
  const auth = new RefreshTokenAuth(
    "QuickBooks",
    env.QBO_TOKEN_URL?.trim() || "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    { client_id: v.QBO_CLIENT_ID, client_secret: v.QBO_CLIENT_SECRET },
    v.QBO_REFRESH_TOKEN,
    { basic: true, onRotate: opts.onRotate },
  );
  const call = async <T>(path: string, init: RequestInit = {}) =>
    fetchJson<T>(
      `${base}${path}${path.includes("?") ? "&" : "?"}${MINOR}`,
      { ...init, headers: { Authorization: `Bearer ${await auth.token()}`, Accept: "application/json", "Content-Type": "application/json" } },
      (s, body) => new ProviderError("QuickBooks", s, body),
    );
  const query = <T>(q: string) => call<{ QueryResponse: T }>(`/query?query=${encodeURIComponent(q)}`);

  return {
    name: "QuickBooks",
    async pushInvoice(inv: FinanceInvoice) {
      const found = await query<{ Customer?: { Id: string }[] }>(`select Id from Customer where DisplayName = '${quote(inv.customerName)}'`);
      const customerId = found.QueryResponse.Customer?.[0]?.Id
        ?? (await call<{ Customer: { Id: string } }>("/customer", { method: "POST", body: JSON.stringify({ DisplayName: inv.customerName, ...(inv.customerEmail ? { PrimaryEmailAddr: { Address: inv.customerEmail } } : {}) }) })).Customer.Id;
      const items = await query<{ Item?: { Id: string }[] }>("select Id from Item where Type = 'Service' maxresults 1");
      const itemId = items.QueryResponse.Item?.[0]?.Id;
      if (!itemId) throw new ProviderError("QuickBooks", 422, "Add a service item (for example \"Freight\") in QuickBooks first");
      const r = await call<{ Invoice: { Id: string; DocNumber?: string } }>("/invoice", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerId },
          DocNumber: inv.number.slice(0, 21),
          TxnDate: inv.date,
          ...(inv.customerEmail ? { BillEmail: { Address: inv.customerEmail } } : {}),
          Line: inv.lines.map((l) => ({ Amount: Math.round(l.amount * 100) / 100, Description: l.description, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: itemId } } })),
        }),
      });
      return { id: r.Invoice.Id };
    },
  };
}
