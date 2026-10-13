import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { memoryStore } from "@onixus/providers";
import { createApp } from "./app.js";

// Veltra links with one click: the Veltra account signed in with the
// owner's own email gets a key that works inside this company only, never on
// platform routes or connections, and stops working when it is unlinked.

const KEY = "test-key-0123456789abcdefghij";
const VELTRA_KEY = "veltra-admin-key-0123456789abcdef";
const SECRET = "connections-secret-0123456789abcdefghij";
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@harbor.test" };
const ACCOUNT = "55555555-5555-4555-8555-555555555555";

test("Veltra: one-click link by the owner's own email, a company-only key, revoked on unlink", async () => {
  const calls: { method: string; path: string; auth?: string; body: any }[] = [];
  let pack: { org_id: string } | null = null;
  const read = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
  const fake = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
    const json = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${VELTRA_KEY}`) return json(401, { error: "Send VELTRA_API_KEY" });
    const account = () => ({ id: ACCOUNT, name: "Harbor Drayage", mailbox: "ops@harbor.test", onixus_org: pack?.org_id ?? null });
    if (req.url === "/admin/packs/onixus" && req.method === "PUT") {
      if (body.email !== "owner@harbor.test") return json(404, { error: `No Veltra account signs in with ${body.email}` });
      pack = { org_id: body.org_id };
      return json(200, { account: account() });
    }
    if (req.url === `/admin/accounts/${ACCOUNT}`) return json(200, { account: account() });
    if (req.url?.startsWith(`/admin/accounts/${ACCOUNT}/packs/onixus?org_id=`) && req.method === "DELETE") {
      if (pack?.org_id === new URL(req.url, "http://x").searchParams.get("org_id")) pack = null;
      return json(200, { account: account() });
    }
    json(404, { error: "no route" });
  }).listen(0);
  const veltraUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const store = memoryStore({
    organizations: [{ id: ORG, name: "Harbor Drayage" }, { id: OTHER_ORG, name: "Elsewhere" }],
    memberships: [{ id: "m1", org_id: ORG, user_id: OWNER.id, email: OWNER.email, role: "OWNER", driver_id: null }],
    loads: [
      { id: "33333333-3333-4333-8333-333333333333", org_id: ORG, load_number: "L-1", equipment_type: "DRY_VAN", status: "BOOKED" },
      { id: "33333333-3333-4333-8333-333333333334", org_id: OTHER_ORG, load_number: "X-1", equipment_type: "DRY_VAN", status: "BOOKED" },
    ],
  });
  const env = { TMS_API_KEY: KEY, CONNECTIONS_SECRET: SECRET, WEB_ORIGIN: "https://app.test", API_PUBLIC_URL: "https://api.test", EMAIL_PROVIDER: "resend" };
  const deps = { store: () => store, verifyUser: async (t: string) => (t === "tok-owner" ? OWNER : null) };
  const unset = createApp(env, deps).listen(0);
  const server = createApp({ ...env, VELTRA_URL: veltraUrl, VELTRA_API_KEY: VELTRA_KEY }, deps).listen(0);
  const at = (s: typeof server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token = "tok-owner", extra: Record<string, string> = {}, s = server) => {
    const res = await fetch(at(s) + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra } });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    const tile = (await call("GET", "/connections")).body.categories.find((c: any) => c.category === "inbox").providers[0];
    assert.deepEqual([tile.id, tile.method, tile.ready], ["veltra", "link", true]);
    assert.equal((await call("POST", "/connections/veltra/link", "tok-owner", {}, unset)).status, 503, "not offered until Onixus sets Veltra up");

    // Linked: Veltra got this company's id, Onixus's address and a fresh key; only its hash is kept.
    const linked = await call("POST", "/connections/veltra/link");
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.detail, "Veltra is working ops@harbor.test with Onixus");
    assert.equal(linked.body.connection.account, "Harbor Drayage · ops@harbor.test");
    const sent = calls.find((c) => c.method === "PUT")!.body;
    assert.deepEqual([sent.email, sent.org_id, sent.api_url], [OWNER.email, ORG, "https://api.test"]);
    const companyKey: string = sent.api_key;
    assert.match(companyKey, /^onx_[\w-]{43}$/);
    assert.equal(store.tables.api_keys!.length, 1);
    assert.ok(!JSON.stringify(store.tables).includes(companyKey), "only a hash of the key is stored");
    assert.equal((await call("POST", "/connections/inbox/test")).body.detail, "Veltra is working ops@harbor.test with Onixus");

    // The key acts inside its own company, and nowhere else.
    const loads = await call("GET", "/loads", companyKey);
    assert.equal(loads.status, 200, JSON.stringify(loads.body));
    assert.deepEqual(loads.body.loads.map((l: any) => l.load_number), ["L-1"]);
    assert.equal((await call("GET", "/loads", companyKey, { "x-org-id": OTHER_ORG })).status, 403, "it can't name another company");
    assert.equal((await call("GET", "/providers", companyKey)).status, 403, "no platform routes");
    assert.equal((await call("POST", "/fmcsa/recheck", companyKey)).status, 403);
    assert.equal((await call("DELETE", "/connections/inbox", companyKey)).status, 403, "it can't change connections");
    assert.equal((await call("GET", "/loads", "onx_made-up-key")).status, 401);

    // Unlinked: the key stops working at once, and Veltra forgets it.
    assert.equal((await call("DELETE", "/connections/inbox")).body.removed, true);
    assert.equal((await call("GET", "/loads", companyKey)).status, 401);
    assert.equal(pack, null);

    // No Veltra account with the owner's email: nothing is linked and no key is left behind.
    OWNER.email = "someone@else.test";
    const missing = await call("POST", "/connections/veltra/link");
    assert.equal(missing.status, 422);
    assert.match(missing.body.error, /No Veltra account uses someone@else\.test\. Sign in to Veltra with that email/);
    assert.equal(store.tables.api_keys!.filter((k: any) => !k.revoked_at).length, 0);
  } finally {
    OWNER.email = "owner@harbor.test";
    server.close();
    unset.close();
    fake.close();
  }
});
