import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { memoryStore, seal, signToken, unseal, verifyToken } from "@onixus/providers";
import { createApp } from "./app.js";

const KEY = "test-key-0123456789abcdefghij";
const SECRET = "connections-secret-0123456789abcdefghij";
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@harbor.test" };
const DISPATCHER = { id: "22222222-2222-4222-8222-222222222222", email: "disp@harbor.test" };

test("sealed credentials and signed state can't be read or forged without the secret", () => {
  const sealed = seal(SECRET, { token: "abc" });
  assert.ok(!sealed.includes("abc"));
  assert.deepEqual(unseal(SECRET, sealed), { token: "abc" });
  assert.throws(() => unseal("another-secret-0123456789abcdefghijklmn", sealed));
  const t = signToken(SECRET, { org: ORG, exp: Date.now() + 60_000 });
  assert.equal(verifyToken<{ org: string }>(SECRET, t)?.org, ORG);
  // Every last character: some decode to the same bytes as the real one, and must still be refused.
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") if (c !== t.at(-1)) assert.equal(verifyToken(SECRET, t.slice(0, -1) + c), null, `last character ${c}`);
  assert.equal(verifyToken(SECRET, signToken(SECRET, { exp: Date.now() - 1 })), null, "expired");
});

test("a company connects its own GPS, CRM, mailbox and books, and the app uses them", async () => {
  // One stand-in for Samsara, HubSpot, Google sign-in, Gmail and QuickBooks.
  const seen: { path: string; auth?: string; body: string }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
  const fake = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? "";
    seen.push({ path, auth: req.headers.authorization, body });
    const json = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path.startsWith("/samsara/fleet/vehicles/stats")) {
      return req.headers.authorization === "Bearer good-samsara" ? json(200, { data: [{ id: "281474", name: "T-101", gps: { time: "2026-10-12T14:59:00Z", latitude: 40.68, longitude: -74.15, headingDegrees: 90, speedMilesPerHour: 41.6 } }], pagination: { hasNextPage: false } }) : json(401, { message: "Unauthorized" });
    }
    if (path === "/hubspot/companies/search") return json(200, { results: [] });
    if (path === "/hubspot/companies") return json(201, { id: "hs-501", properties: { name: JSON.parse(body).properties.name } });
    if (path === "/hubspot/contacts") return json(201, { id: "hc-1" });
    if (path === "/google/token") {
      const p = new URLSearchParams(body);
      const claims = Buffer.from(JSON.stringify({ email: "dispatch@harbor.test" })).toString("base64url");
      if (p.get("grant_type") === "authorization_code") return p.get("code") === "good-code" ? json(200, { access_token: "g-at", refresh_token: "g-rt", expires_in: 3600, id_token: `x.${claims}.y` }) : json(400, { error: "invalid_grant" });
      return json(200, { access_token: "g-at2", expires_in: 3600 });
    }
    if (path === "/gmail/messages/send") return json(200, { id: "gm-1" });
    if (path === "/qbo/token") return json(200, { access_token: "q-at", refresh_token: "q-rt-rotated", expires_in: 3600 });
    if (path.startsWith("/qbo/v3/company/9130/query")) {
      const q = decodeURIComponent(path.split("query=")[1]!.split("&")[0]!);
      return json(200, { QueryResponse: q.includes("from Item") ? { Item: [{ Id: "7" }] } : {} });
    }
    if (path.startsWith("/qbo/v3/company/9130/customer")) return json(200, { Customer: { Id: "c-88" } });
    if (path.startsWith("/qbo/v3/company/9130/invoice")) return json(200, { Invoice: { Id: "qi-42" } });
    json(404, { path });
  }).listen(0);
  const up = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const store = memoryStore({
    organizations: [{ id: ORG, name: "Harbor Drayage" }],
    memberships: [
      { id: "m1", org_id: ORG, user_id: OWNER.id, email: OWNER.email, role: "OWNER", driver_id: null },
      { id: "m2", org_id: ORG, user_id: DISPATCHER.id, email: DISPATCHER.email, role: "DISPATCHER", driver_id: null },
    ],
  });
  const people: Record<string, typeof OWNER> = { "tok-owner": OWNER, "tok-disp": DISPATCHER };
  const server = createApp({
    TMS_API_KEY: KEY, CONNECTIONS_SECRET: SECRET, WEB_ORIGIN: "https://app.test", API_PUBLIC_URL: "https://api.test",
    GMAIL_CLIENT_ID: "g-client", GMAIL_CLIENT_SECRET: "g-secret", GOOGLE_TOKEN_URL: `${up}/google/token`, GMAIL_API_URL: `${up}/gmail`,
    QBO_CLIENT_ID: "q-client", QBO_CLIENT_SECRET: "q-secret", QBO_TOKEN_URL: `${up}/qbo/token`, QBO_BASE_URL: `${up}/qbo`,
    SAMSARA_BASE_URL: `${up}/samsara`, HUBSPOT_API_URL: `${up}/hubspot`, TRACCAR_URL: "", EMAIL_PROVIDER: "resend",
  }, { store: () => store, verifyUser: async (t) => people[t] ?? null }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token = "tok-owner") => {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() as any : null, location: res.headers.get("location") };
  };

  try {
    // Every category lists every choice, Veltra included; the shared defaults apply until something is connected.
    const list = (await call("GET", "/connections")).body;
    assert.equal(list.encryption, true);
    const ids = Object.fromEntries(list.categories.map((c: any) => [c.category, c.providers.map((p: any) => p.id)]));
    assert.deepEqual(ids, { email: ["gmail", "outlook", "veltra"], crm: ["hubspot", "veltra-crm"], finance: ["quickbooks", "veltrafi"], tracking: ["samsara", "motive", "traccar"] });
    assert.equal(list.categories[0].providers[1].ready, false, "Outlook needs Onixus's Microsoft app first");
    assert.equal((await call("POST", "/connections/veltra-crm", {})).status, 409);

    // GPS: a wrong token is refused at connect time; the right one shows the company's own trucks.
    assert.equal((await call("POST", "/connections/samsara", { token: "good-samsara" }, "tok-disp")).status, 403, "only owners connect");
    const bad = await call("POST", "/connections/samsara", { token: "nope" });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error, /Samsara didn't accept that/);
    const ok = await call("POST", "/connections/samsara", { token: "good-samsara" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.detail, "1 vehicle(s) reporting");
    assert.ok(!JSON.stringify(store.tables.connections).includes("good-samsara"), "the token is stored sealed");
    const gps = (await call("GET", "/tracking", undefined, "tok-disp")).body;
    assert.equal(gps.source, "connected");
    assert.deepEqual([gps.vehicles[0].name, gps.vehicles[0].speedMph], ["T-101", 42]);

    // CRM: new customers go to HubSpot.
    assert.equal((await call("POST", "/connections/hubspot", { token: "pat-1" })).status, 201);
    const cust = (await call("POST", "/customers", { type: "SHIPPER", company_name: "Northstar Furniture", email: "ap@northstar.test" })).body;
    assert.equal(cust.customer.crm_ref, "hs-501");
    assert.ok(seen.some((s) => s.path === "/hubspot/contacts"), "the billing contact goes too");

    // Email: sign in with Google; the state is signed and expires; the app then sends from the company's Gmail.
    const start = await call("POST", "/connections/gmail/start");
    const url = new URL(start.body.url);
    assert.equal(url.searchParams.get("redirect_uri"), "https://api.test/connections/oauth/callback");
    assert.match(url.searchParams.get("scope")!, /gmail\.send/);
    const state = url.searchParams.get("state")!;
    const forged = await fetch(`${base}/connections/oauth/callback?state=${state}x&code=good-code`, { redirect: "manual" });
    assert.match(forged.headers.get("location")!, /connection_error/);
    const back = await fetch(`${base}/connections/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`, { redirect: "manual" });
    assert.equal(back.headers.get("location"), "https://app.test/?connected=gmail");
    const email = (await call("GET", "/connections")).body.categories.find((c: any) => c.category === "email").connection;
    assert.deepEqual([email.provider, email.account, email.connected_by], ["gmail", "dispatch@harbor.test", OWNER.email]);
    const status = (await call("GET", "/comms/status")).body.email;
    assert.deepEqual([status.ready, status.account], [true, "dispatch@harbor.test"]);
    const load = (await call("POST", "/loads", { equipment_type: "BOX_TRUCK", customer_id: cust.customer.id, rate: 400 })).body.load;
    const sent = await call("POST", "/emails", { to: "ap@northstar.test", subject: "Hello", body: "Hi", load_id: load.id });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.email.provider, "gmail");
    const raw = Buffer.from(JSON.parse(seen.find((s) => s.path === "/gmail/messages/send")!.body).raw, "base64url").toString();
    assert.match(raw, /From: Harbor Drayage <dispatch@harbor.test>/);

    // Books: QuickBooks sign-in carries the company id; an invoice goes over once, and a rotated refresh token is kept.
    const q = new URL((await call("POST", "/connections/quickbooks/start")).body.url);
    await fetch(`${base}/connections/oauth/callback?state=${encodeURIComponent(q.searchParams.get("state")!)}&code=good-code&realmId=9130`, { redirect: "manual" });
    store.tables.invoices = [{ id: "33333333-3333-4333-8333-333333333333", org_id: ORG, invoice_number: "INV-000007", customer_id: cust.customer.id, amount: 760, status: "DRAFT", created_at: "2026-10-12T15:00:00Z", accessorials: [{ code: "LINEHAUL", description: "Box truck", amount: 650 }, { code: "WAITING", description: "Waiting time", amount: 110 }] }];
    const pushed = await call("POST", "/invoices/33333333-3333-4333-8333-333333333333/push");
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(pushed.body.invoice.finance_ref, "qi-42");
    const qboAuth = seen.find((s) => s.path === "/qbo/token")!;
    assert.equal(qboAuth.auth, `Basic ${Buffer.from("q-client:q-secret").toString("base64")}`, "Intuit gets Basic auth");
    const qInvoice = JSON.parse(seen.find((s) => s.path.startsWith("/qbo/v3/company/9130/invoice"))!.body);
    assert.deepEqual(qInvoice.Line.map((l: any) => [l.Amount, l.SalesItemLineDetail.ItemRef.value]), [[650, "7"], [110, "7"]]);
    assert.equal(qInvoice.CustomerRef.value, "c-88", "the customer is created in QuickBooks when missing");
    assert.equal((await call("POST", "/invoices/33333333-3333-4333-8333-333333333333/push")).status, 409, "only once");
    await new Promise((r) => setTimeout(r, 20));
    const fin = store.tables.connections.find((c) => c.category === "finance")!;
    assert.equal(unseal(SECRET, fin.secret as string).refresh_token, "q-rt-rotated", "Intuit's rotated refresh token is saved");

    // Disconnect: owners only, and the shared defaults come back.
    assert.equal((await call("DELETE", "/connections/tracking", undefined, "tok-disp")).status, 403);
    assert.equal((await call("DELETE", "/connections/tracking")).body.removed, true);
    assert.equal((await call("GET", "/connections")).body.categories.find((c: any) => c.category === "tracking").connection, null);
  } finally {
    server.close();
    fake.close();
  }
});
