import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError, type CrmCompany, type CrmProvider } from "../types.js";

// HubSpot CRM v3 with a private-app access token (Settings → Integrations →
// Private apps; scopes crm.objects.companies.read/write, crm.objects.contacts.write).
export const HUBSPOT_VARS = ["HUBSPOT_ACCESS_TOKEN"] as const;
const API_DEFAULT = "https://api.hubapi.com/crm/v3/objects";
// Customer type (SHIPPER, BROKER, …) is stored in a custom company property;
// create it in HubSpot or change the name here.
const TYPE_PROPERTY = "onixus_customer_type";

type HubCompany = { id: string; properties: Record<string, string | null> };

const toCompany = (c: HubCompany): CrmCompany => ({
  id: c.id,
  name: c.properties.name ?? "",
  domain: c.properties.domain ?? undefined,
  type: c.properties[TYPE_PROPERTY] ?? undefined,
});

export function hubspot(env: Env): CrmProvider {
  const v = requireVars(env, "HubSpot", [...HUBSPOT_VARS]);
  const API = env.HUBSPOT_API_URL?.trim() || API_DEFAULT;
  const call = <T>(path: string, init: RequestInit = {}) =>
    fetchJson<T>(
      `${API}${path}`,
      { ...init, headers: { Authorization: `Bearer ${v.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" } },
      (status, text) => new ProviderError("HubSpot", status, text),
    );

  return {
    name: "hubspot",
    async searchCompanies(query, limit) {
      const r = await call<{ results: HubCompany[] }>("/companies/search", {
        method: "POST",
        body: JSON.stringify({ query, limit, properties: ["name", "domain", TYPE_PROPERTY] }),
      });
      return r.results.map(toCompany);
    },
    async createCompany(c) {
      const properties: Record<string, string> = { name: c.name };
      if (c.domain) properties.domain = c.domain;
      if (c.phone) properties.phone = c.phone;
      if (c.type) properties[TYPE_PROPERTY] = c.type;
      return toCompany(await call<HubCompany>("/companies", { method: "POST", body: JSON.stringify({ properties }) }));
    },
    async createContact(c) {
      const properties: Record<string, string> = { email: c.email };
      if (c.firstName) properties.firstname = c.firstName;
      if (c.lastName) properties.lastname = c.lastName;
      if (c.phone) properties.phone = c.phone;
      const body: Record<string, unknown> = { properties };
      if (c.companyId) {
        // 279 = HubSpot-defined contact→company primary association.
        body.associations = [{ to: { id: c.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 279 }] }];
      }
      const r = await call<{ id: string }>("/contacts", { method: "POST", body: JSON.stringify(body) });
      return { id: r.id };
    },
  };
}
