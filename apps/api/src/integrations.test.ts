import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { checkWebhookUrl, eventId, isPublicIp, memoryStore, webhookPoster } from "@onixus/providers";
import { createApp } from "./app.js";

// The company's own AI key, automations, Slack, calendar, Drive and Sheets:
// each connects, each is checked at connect time, and each is used by the
// office without the office doing anything extra.

const KEY = "test-key-0123456789abcdefghij";
const SECRET = "connections-secret-0123456789abcdefghij";
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@harbor.test" };
const LOAD = "33333333-3333-4333-8333-333333333333";
const LEG = "44444444-4444-4444-8444-444444444444";

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("webhook URLs typed in by a company only ever reach the public internet", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.1.1", "::1", "fd12::1", "::ffff:127.0.0.1"]) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ["8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicIp(ip), true, ip);
  for (const bad of ["http://hooks.zapier.com/x", "https://10.0.0.1/hook", "https://localhost/hook", "https://example.com:8443/x", "https://u:p@example.com/x", "not a url"]) assert.throws(() => checkWebhookUrl(bad), Error, bad);
  assert.equal(checkWebhookUrl("https://n8n.harbor.example/webhook/abc").host, "n8n.harbor.example");
  assert.match(eventId("leg:44444444-4444"), /^onx[0-9a-f]+$/, "a valid Google event id (base32hex)");
});

test("AI key, Zapier, Slack, Google Calendar, Drive and Sheets: connected, checked and used", async () => {
  // One stand-in for the AI provider and Google (sign-in, Calendar, Drive, Sheets).
  const seen: { method: string; path: string; auth?: string; body: string }[] = [];
  const events = new Map<string, Record<string, unknown>>();
  const read = (req: IncomingMessage) => new Promise<Buffer>((ok) => { const b: Buffer[] = []; req.on("data", (c) => b.push(c)); req.on("end", () => ok(Buffer.concat(b))); });
  const fake = createServer(async (req, res) => {
    const raw = await read(req);
    const body = raw.toString("utf8");
    const path = req.url ?? "";
    const method = req.method ?? "GET";
    seen.push({ method, path, auth: req.headers.authorization, body });
    const json = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path === "/or/chat/completions") {
      const model = JSON.parse(body).model;
      return json(200, { id: "c1", object: "chat.completion", created: 1, model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: req.headers.authorization === "Bearer sk-or-company" ? "Two loads are on the road." : "wrong key" } }] });
    }
    if (path === "/google/token") {
      const p = new URLSearchParams(body);
      const claims = Buffer.from(JSON.stringify({ email: "ops@harbor.test" })).toString("base64url");
      if (p.get("grant_type") === "authorization_code") return json(200, { access_token: "g-at", refresh_token: "g-rt", expires_in: 3600, id_token: `x.${claims}.y` });
      return json(200, { access_token: "g-at2", expires_in: 3600 });
    }
    // Calendar: PUT on an unknown event is a 404, then the insert creates it.
    if (path === "/cal/calendars/primary") return json(200, { summary: "Harbor dispatch" });
    const ev = path.match(/^\/cal\/calendars\/primary\/events\/(\w+)$/);
    if (ev && method === "PUT") return events.has(ev[1]!) ? (events.set(ev[1]!, JSON.parse(body)), json(200, {})) : json(404, { error: "not found" });
    if (ev && method === "DELETE") return events.delete(ev[1]!) ? (res.writeHead(204), res.end()) : json(404, {});
    if (path === "/cal/calendars/primary/events" && method === "POST") return (events.set(JSON.parse(body).id, JSON.parse(body)), json(200, {}));
    // Drive and Sheets: nothing exists until Onixus creates it.
    if (path.startsWith("/drive/files?q=")) return json(200, { files: [] });
    if (path === "/drive/files" && method === "POST") return json(200, { id: "folder-1" });
    if (path.startsWith("/upload/files?uploadType=multipart")) return json(200, { id: "file-1", webViewLink: "https://drive.google.com/file/d/file-1/view" });
    if (path === "/sheets/spreadsheets" && method === "POST") return json(200, { spreadsheetId: "sheet-1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1" });
    if (path.startsWith("/sheets/spreadsheets/sheet-1/values/")) return json(200, {});
    json(404, { path });
  }).listen(0);
  const up = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  // Webhooks (Zapier, Slack) are recorded instead of sent.
  const hooks: { url: string; body: any }[] = [];
  const realPost = webhookPoster.post;
  webhookPoster.post = async (url, body) => void hooks.push({ url, body });

  const store = memoryStore({
    organizations: [{ id: ORG, name: "Harbor Drayage" }],
    memberships: [{ id: "m1", org_id: ORG, user_id: OWNER.id, email: OWNER.email, role: "OWNER", driver_id: null }],
    loads: [{ id: LOAD, org_id: ORG, load_number: "L-1001", container_number: "CSQU3054383", equipment_type: "CONTAINER", status: "BOOKED" }],
    load_legs: [{ id: LEG, org_id: ORG, load_id: LOAD, seq: 1, cargo: "LOADED", status: "PLANNED", from_terminal_id: null, from_location_id: null, to_terminal_id: null, to_location_id: null, trip_id: null }],
  });
  const files = { uploadUrl: async () => ({ path: "x", signedUrl: "x", token: "x" }), downloadUrl: async () => "x", download: async () => Buffer.from("%PDF-1.7 the bol") };
  const server = createApp({
    TMS_API_KEY: KEY, CONNECTIONS_SECRET: SECRET, WEB_ORIGIN: "https://app.test", API_PUBLIC_URL: "https://api.test", EMAIL_PROVIDER: "resend",
    OPENAI_BASE_URL: `${up}/or`, GMAIL_CLIENT_ID: "g-client", GMAIL_CLIENT_SECRET: "g-secret", GOOGLE_TOKEN_URL: `${up}/google/token`,
    GOOGLE_CALENDAR_API_URL: `${up}/cal`, GOOGLE_DRIVE_API_URL: `${up}/drive`, GOOGLE_UPLOAD_API_URL: `${up}/upload`, GOOGLE_SHEETS_API_URL: `${up}/sheets`,
  }, { store: () => store, verifyUser: async (t) => (t === "tok-owner" ? OWNER : null), files: () => files as never }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, redirect: "manual", headers: { authorization: "Bearer tok-owner", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() as any : null };
  };
  const signIn = async (provider: string) => {
    const start = await call("POST", `/connections/${provider}/start`);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const url = new URL(start.body.url);
    const back = await fetch(`${base}/connections/oauth/callback?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=good`, { redirect: "manual" });
    assert.match(back.headers.get("location") ?? "", new RegExp(`connected=${provider}`));
    return url.searchParams.get("scope")!;
  };

  try {
    // AI: the company's key is checked, then answers the office's questions instead of Onixus's.
    const ai = await call("POST", "/connections/openai", { api_key: "sk-or-company", model: "deepseek/deepseek-v4.1-flash" });
    assert.equal(ai.status, 201, JSON.stringify(ai.body));
    assert.equal(ai.body.detail, "deepseek/deepseek-v4.1-flash answered");
    assert.equal(ai.body.connection.account, "OpenAI · deepseek/deepseek-v4.1-flash");
    const asked = await call("POST", "/assistant/ask", { question: "What's on the road?" });
    assert.equal(asked.body.answer, "Two loads are on the road.");
    assert.ok(!JSON.stringify(store.tables.connections).includes("sk-or-company"), "the key is stored sealed");

    // Automations and Slack: wrong URLs are refused, the right ones get a test, then real events.
    assert.equal((await call("POST", "/connections/zapier", { url: "https://evil.test/hook" })).status, 400);
    assert.equal((await call("POST", "/connections/n8n", { url: "https://10.0.0.7/webhook/x" })).status, 422, "private addresses are refused");
    assert.equal((await call("POST", "/connections/zapier", { url: "https://hooks.zapier.com/hooks/catch/123/abc" })).body.detail, "Test event delivered");
    assert.equal((await call("POST", "/connections/slack", { url: "https://hooks.slack.com/services/T0/B0/xyz" })).body.detail, "Test message posted");
    hooks.length = 0;
    const made = await call("POST", "/loads", { equipment_type: "DRY_VAN", customer_reference: "PO-9" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await until(() => hooks.length >= 2, "the load.created event");
    const zap = hooks.find((h) => h.url.includes("zapier"))!;
    assert.deepEqual([zap.body.event, zap.body.company_id, zap.body.data.load_id], ["load.created", ORG, made.body.load.id]);
    assert.match(hooks.find((h) => h.url.includes("slack"))!.body.text, /^📦 New load/);

    // Google Calendar: an appointment becomes an event, moves with it, and goes when it's cleared.
    assert.match(await signIn("google-calendar"), /calendar\.events/);
    assert.equal((await call("POST", "/connections/calendar/test")).body.detail, "Calendar “Harbor dispatch” reachable");
    await call("PATCH", `/legs/${LEG}`, { appointment_at: "2026-10-14T13:00:00Z", appointment_number: "APT-77" });
    const id = eventId(`leg:${LEG}`);
    await until(() => events.has(id), "the calendar event");
    assert.equal(events.get(id)!.summary, "CSQU3054383 · pickup → delivery");
    assert.deepEqual(events.get(id)!.start, { dateTime: "2026-10-14T13:00:00.000Z" });
    await call("PATCH", `/legs/${LEG}`, { appointment_at: "2026-10-14T15:30:00Z" });
    await until(() => (events.get(id)!.start as any).dateTime === "2026-10-14T15:30:00.000Z", "the moved event");
    assert.equal(seen.filter((s) => s.path === "/cal/calendars/primary/events" && s.method === "POST").length, 1, "moved, not duplicated");
    await call("PATCH", `/legs/${LEG}`, { appointment_at: null });
    await until(() => !events.has(id), "the removed event");

    // Google Drive: only drive.file (Onixus's own files); an uploaded BOL is copied into the Onixus folder.
    assert.equal(await signIn("google-drive"), "openid email https://www.googleapis.com/auth/drive.file");
    const doc = await call("POST", `/loads/${LOAD}/documents`, { kind: "BOL", path: `${ORG}/${LOAD}/bol-1.pdf`, file_name: "bol.pdf", content_type: "application/pdf" });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    await until(() => seen.some((s) => s.path.startsWith("/upload/files")), "the Drive upload");
    const upload = seen.find((s) => s.path.startsWith("/upload/files"))!;
    assert.match(upload.body, /"name":"CSQU3054383 · BOL · bol\.pdf","parents":\["folder-1"\]/);
    assert.match(upload.body, /%PDF-1\.7 the bol/);

    // Google Sheets: the load log is created once, with a header, and gets a row per event, as plain text.
    await signIn("google-sheets");
    assert.equal((await call("POST", "/connections/reports/test")).body.detail, "Load log ready: https://docs.google.com/spreadsheets/d/sheet-1");
    await call("POST", "/loads", { equipment_type: "BOX_TRUCK", customer_reference: "=HYPERLINK(\"x\")" });
    await until(() => seen.filter((s) => s.path.includes("sheet-1/values")).length >= 2, "the log row");
    const rows = seen.filter((s) => s.path.includes("sheet-1/values"));
    assert.match(rows[0]!.body, /"When","Event","Load","Container"/);
    assert.match(rows[1]!.path, /valueInputOption=RAW/, "never USER_ENTERED: customer text can't become a formula");
    assert.match(rows[1]!.body, /"load\.created"/);
  } finally {
    webhookPoster.post = realPost;
    server.close();
    fake.close();
  }
});
