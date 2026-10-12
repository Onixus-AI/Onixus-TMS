import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { gmailRaw, providerStatus, selected } from "@onixus/providers";

const KEY = "test-key-0123456789abcdefghij";

async function withServer(env: Record<string, string>, fn: (url: string) => Promise<void>) {
  const server = createApp({ TMS_API_KEY: KEY, ...env }).listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

test("refuses to start without a strong API key", () => {
  assert.throws(() => createApp({}), /TMS_API_KEY/);
  assert.throws(() => createApp({ TMS_API_KEY: "short" }), /TMS_API_KEY/);
});

test("every route but /health needs the API key", async () => {
  await withServer({}, async (url) => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    for (const path of ["/providers", "/email/unread", "/crm/companies?q=x"]) {
      assert.equal((await fetch(url + path)).status, 401, path);
      assert.equal((await fetch(url + path, { headers: { authorization: "Bearer wrong-key-0123456789abcdef" } })).status, 401, path);
    }
    const send = await fetch(`${url}/email/send`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(send.status, 401, "sending mail must not be open");
  });
});

test("providers are chosen by environment, aliases included", () => {
  assert.equal(selected("email", {}), "gmail");
  assert.equal(selected("email", { EMAIL_PROVIDER: "Outlook" }), "microsoft");
  assert.equal(selected("llm", { LLM_PROVIDER: "openai" }), "openai");
  assert.equal(selected("llm", { LLM_PROVIDER: "onyx" }), "onyx");
  assert.equal(selected("crm", { CRM_PROVIDER: "hubspot" }), "hubspot");
  assert.throws(() => selected("email", { EMAIL_PROVIDER: "yahoo" }), /gmail, microsoft, onyx/);
});

test("status names exactly the missing credentials", () => {
  const s = providerStatus({ EMAIL_PROVIDER: "microsoft", MS_CLIENT_ID: "x", LLM_PROVIDER: "claude", ANTHROPIC_API_KEY: "k" });
  const email = s.find((p) => p.capability === "email")!;
  assert.deepEqual(email.missing, ["MS_CLIENT_SECRET", "MS_REFRESH_TOKEN"]);
  assert.equal(s.find((p) => p.capability === "llm")!.configured, true);
});

test("Onyx Mail and Onyx CRM answer 501, never a fake success", async () => {
  await withServer({ EMAIL_PROVIDER: "onyx", CRM_PROVIDER: "onyx" }, async (url) => {
    const r = await fetch(`${url}/email/send`, { method: "POST", headers: auth, body: JSON.stringify({ to: "a@b.co", subject: "s", html: "<p>x</p>" }) });
    assert.equal(r.status, 501);
    assert.match((await r.json()).error, /Onyx Mail is coming soon/);
    assert.equal((await fetch(`${url}/crm/companies?q=acme`, { headers: auth })).status, 501);
    const status = await (await fetch(`${url}/providers`, { headers: auth })).json();
    assert.equal(status.providers.find((p: { capability: string }) => p.capability === "email").available, false);
  });
});

test("an unconfigured provider answers 503 naming what to set", async () => {
  await withServer({ LLM_PROVIDER: "openai" }, async (url) => {
    const r = await fetch(`${url}/llm/complete`, { method: "POST", headers: auth, body: JSON.stringify({ prompt: "hi" }) });
    assert.equal(r.status, 503);
    assert.deepEqual((await r.json()).missing, ["OPENAI_API_KEY"]);
  });
});

test("bad input is a 400, not a provider call", async () => {
  await withServer({ EMAIL_PROVIDER: "onyx" }, async (url) => {
    const r = await fetch(`${url}/email/send`, { method: "POST", headers: auth, body: JSON.stringify({ to: "not-an-email", subject: "", html: "" }) });
    assert.equal(r.status, 400);
  });
});

test("Gmail messages cannot smuggle headers through CR/LF", () => {
  const raw = Buffer.from(gmailRaw("me@onixus.xyz", { to: "a@b.co\r\nBcc: victim@x.co", subject: "Hi\nBcc: x@y.z", html: "<p>x</p>" }), "base64url").toString();
  const headers = raw.split("\r\n\r\n")[0];
  assert.doesNotMatch(headers, /^Bcc:/m);
});
