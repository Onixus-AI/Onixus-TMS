import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import {
  authorizeUrl, CATEGORIES, connector, CONNECTORS, exchangeCode, oauthReady, ProviderError, scopedStore, seal, signToken, unseal, veltra, verifyToken,
  type Automation, type Built, type Calendar, type Category, type Chat, type Documents, type Sheet, type Connector, type CrmProvider, type EmailProvider, type LlmProvider, type TrackingProvider,
} from "@onixus/providers";
import { COMPANY_KEY_PREFIX, forgetCompanyKeys, keyHash } from "../auth.js";
import { HttpError, type Ctx } from "../http.js";

// Each company's own connections: its mailbox, CRM, books, GPS, AI key,
// automations and calendar. Owners
// connect and disconnect; everyone in the office sees what is connected.
// Credentials are sealed before they are stored and never sent back.

type ConnectionRow = { id: string; org_id: string; category: Category; provider: string; account: string | null; secret: string; status: "CONNECTED" | "ERROR"; last_error: string | null; connected_by: string | null; created_at: string; updated_at: string };

const secretOf = (ctx: Ctx) => ctx.env.CONNECTIONS_SECRET?.trim() ?? "";

function orgAndUser(ctx: Ctx) {
  const c = ctx.caller();
  const orgId = c?.kind === "system" ? c.orgId : c?.member?.org_id;
  if (!orgId) throw new HttpError(403, "Join or create a company first");
  // A company key (Veltra) works inside the company but never changes its connections.
  return { orgId, email: c?.kind === "user" ? c.user.email : "platform", owner: (c?.kind === "system" && !c.keyId) || (c?.kind === "user" && c.member?.role === "OWNER") };
}
function mustOwn(ctx: Ctx) {
  const who = orgAndUser(ctx);
  if (!who.owner) throw new HttpError(403, "Only an owner can change connections");
  return who;
}

async function rowFor(ctx: Ctx, category: Category) {
  const [row] = await ctx.store().list<ConnectionRow>("connections", { category }, { limit: 1 });
  return row ?? null;
}

// Built providers keep their access tokens between requests.
const cache = new Map<string, unknown>();

/** The company's connected provider for a category, or null when it has none. */
export async function connected<C extends Category>(ctx: Ctx, category: C): Promise<Built[C] | null> {
  const row = await rowFor(ctx, category);
  if (!row) return null;
  const c = connector(row.provider);
  if (!c?.build) return null;
  const key = `${row.id}:${row.updated_at}`;
  const hit = cache.get(key);
  if (hit) return hit as Built[C];
  const secret = secretOf(ctx);
  const creds = unseal(secret, row.secret);
  const store = ctx.store();
  // Microsoft and Intuit rotate refresh tokens: keep the newest, or the connection dies.
  const onRotate = (refresh_token: string) => {
    void store.update("connections", row.id, { secret: seal(secret, { ...creds, refresh_token }) }).catch(() => {});
  };
  const built = (c.build as NonNullable<Connector<C>["build"]>)(ctx.env, creds, { onRotate });
  if (cache.size > 500) cache.clear();
  cache.set(key, built);
  return built;
}

/** The company's own AI model when it connected one, otherwise Onixus's. */
export async function aiFor(ctx: Ctx): Promise<LlmProvider> {
  return (await connected(ctx, "ai")) ?? ctx.ai();
}

/** Mark a connection broken, with why, so the owner sees it on Connections. */
async function failed(ctx: Ctx, category: Category, e: unknown) {
  const row = await rowFor(ctx, category).catch(() => null);
  if (row) await ctx.store().update("connections", row.id, { status: "ERROR", last_error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).catch(() => {});
}

/** One line for people (Slack) about an event. */
export function eventText(event: string, d: Record<string, unknown>): string {
  const ref = [d.load_number, d.container].filter(Boolean).join(" · ") || "A load";
  if (event === "load.created") return `📦 New load ${ref}${d.source === "delivery_order" ? " from a delivery order" : ""}`;
  if (event === "load.status_changed") return `🚚 ${ref}: ${String(d.from ?? "").toLowerCase().replace(/_/g, " ")} → ${String(d.to ?? "").toLowerCase().replace(/_/g, " ")}`;
  if (event === "invoice.sent") return `🧾 Invoice ${d.invoice_number ?? ""} for $${Number(d.amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })} sent to ${d.to ?? "the customer"}${d.container ? ` (${d.container})` : ""}`;
  return `${event} · ${ref}`;
}

/**
 * Tell the company's connected tools something happened: its automation
 * (Zapier, Make, n8n) gets the event as JSON, its chat (Slack) a line, and
 * its load log (Google Sheets) a row. Never slows or fails the request; a
 * tool that fails is marked "Needs attention" on Connections.
 */
export function notify(ctx: Ctx, event: string, data: Record<string, unknown>) {
  const c = ctx.caller();
  const company_id = c?.kind === "system" ? c.orgId : c?.member?.org_id;
  const at = ctx.now().toISOString();
  void connected(ctx, "automation").then((a) => a?.send({ event, at, company_id: company_id ?? null, data })).catch((e) => failed(ctx, "automation", e));
  void connected(ctx, "chat").then((ch) => ch?.send(eventText(event, data))).catch((e) => failed(ctx, "chat", e));
  const details = event === "invoice.sent" ? `Invoice ${data.invoice_number ?? ""} · $${data.amount ?? ""} · ${data.to ?? ""}` : String(data.source ?? "");
  void connected(ctx, "reports")
    .then((s) => s?.append([at, event, (data.load_number as string) ?? "", (data.container as string) ?? "", (data.from as string) ?? "", (data.to as string) ?? (data.status as string) ?? "", details]))
    .catch((e) => failed(ctx, "reports", e));
}

/** Copy a load document to the company's Drive. Never fails the upload. */
export function saveToDrive(ctx: Ctx, name: string, read: () => Promise<Buffer>, mimeType: string) {
  void connected(ctx, "documents").then(async (d) => (d ? d.save(name, await read(), mimeType) : undefined)).catch((e) => failed(ctx, "documents", e));
}

/** Put a leg's appointment on the company's calendar, move it, or take it off. Never fails the request. */
export function syncAppointment(ctx: Ctx, key: string, event: Parameters<Calendar["upsert"]>[1] | null) {
  void connected(ctx, "calendar")
    .then((cal) => (cal ? (event ? cal.upsert(key, event) : cal.remove(key)) : undefined))
    .catch((e) => failed(ctx, "calendar", e));
}

async function save(ctx: Ctx, c: Connector, account: string, creds: Record<string, string>, who: { email: string }) {
  const store = ctx.store();
  const existing = await rowFor(ctx, c.category);
  const row = { category: c.category, provider: c.id, account, secret: seal(secretOf(ctx), creds), status: "CONNECTED", last_error: null, connected_by: who.email, updated_at: ctx.now().toISOString() };
  return existing ? store.update<ConnectionRow>("connections", existing.id, row) : store.insert<ConnectionRow>("connections", row);
}

const shown = (r: ConnectionRow) => ({ id: r.id, category: r.category, provider: r.provider, account: r.account, status: r.status, last_error: r.last_error, connected_by: r.connected_by, updated_at: r.updated_at });

/** This API's public address. */
const apiBase = (ctx: Ctx, req: Request) =>
  (ctx.env.API_PUBLIC_URL?.trim() || (ctx.env.RAILWAY_PUBLIC_DOMAIN ? `https://${ctx.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.protocol}://${req.get("host")}`)).replace(/\/$/, "");
/** Where the provider sends the person back to. */
const callbackUrl = (ctx: Ctx, req: Request) => `${apiBase(ctx, req)}/connections/oauth/callback`;

/** Retire a Veltra link: its company key stops working, and Veltra forgets it unless it was linked elsewhere since. */
async function unlinkVeltra(ctx: Ctx, row: ConnectionRow, orgId: string, tellVeltra: boolean) {
  const creds = unseal(secretOf(ctx), row.secret);
  if (creds.key_id) await ctx.store().update("api_keys", creds.key_id, { revoked_at: ctx.now().toISOString() }).then(forgetCompanyKeys, () => {});
  if (tellVeltra && creds.account_id) await veltra(ctx.env).unlink(creds.account_id, orgId).catch(() => {});
}
const webOrigin = (ctx: Ctx) => (ctx.env.WEB_ORIGIN ?? "http://localhost:5173").split(",")[0]!.trim();

/** A quick read with the new credentials, so a wrong key is caught at connect time, not on first use. */
async function check(category: Category, provider: unknown) {
  if (category === "tracking") return `${(await (provider as TrackingProvider).positions()).length} vehicle(s) reporting`;
  if (category === "crm") return (await (provider as CrmProvider).searchCompanies("a", 1), "CRM reachable");
  if (category === "ai") {
    const p = provider as LlmProvider;
    await p.complete({ prompt: "Reply with the single word OK.", maxTokens: 20 });
    return `${p.model} answered`;
  }
  if (category === "automation") {
    await (provider as Automation).send({ event: "connection.test", at: new Date().toISOString(), company_id: null, data: { message: "Onixus Logistics OS is connected. Load and invoice events will arrive here." } });
    return "Test event delivered";
  }
  if (category === "calendar") return `Calendar “${await (provider as Calendar).check()}” reachable`;
  if (category === "chat") return (await (provider as Chat).send("✅ Onixus Logistics OS is connected. Load and invoice updates will appear here."), "Test message posted");
  if (category === "documents") return (provider as Documents).check();
  if (category === "reports") return `Load log ready: ${await (provider as Sheet).check()}`;
  return "ready";
}

/** The provider's sign-in redirect lands here, without our auth header: the signed state says whose it is. */
export function oauthCallback(ctx: Ctx) {
  return async (req: Request, res: import("express").Response) => {
    const back = (q: Record<string, string>) => res.redirect(`${webOrigin(ctx)}/?${new URLSearchParams(q)}`);
    try {
      const q = z.object({ state: z.string().max(2000), code: z.string().max(4000).optional(), error: z.string().max(200).optional(), realmId: z.string().max(40).optional() }).parse(req.query);
      const state = verifyToken<{ org: string; user: string; provider: string; redirect: string }>(secretOf(ctx), q.state);
      if (!state) return back({ connection_error: "That sign-in link expired; start again from Connections" });
      if (q.error || !q.code) return back({ connection_error: `${connector(state.provider)?.label ?? "The provider"} sign-in was cancelled` });
      const c = connector(state.provider);
      if (!c?.oauth) return back({ connection_error: "Unknown connection" });
      const tokens = await exchangeCode(ctx.env, c, q.code, state.redirect);
      const { credentials, account } = c.oauth.identify(tokens, q.realmId ? { realmId: q.realmId } : {});
      // Act inside the company the link was made for.
      const store = scopedStore(ctx.db(), state.org);
      const [existing] = await store.list<ConnectionRow>("connections", { category: c.category }, { limit: 1 });
      const row = { category: c.category, provider: c.id, account, secret: seal(secretOf(ctx), credentials), status: "CONNECTED", last_error: null, connected_by: state.user, updated_at: ctx.now().toISOString() };
      if (existing) await store.update("connections", existing.id, row);
      else await store.insert("connections", row);
      back({ connected: c.id });
    } catch (e) {
      back({ connection_error: e instanceof Error ? e.message.slice(0, 200) : "Could not connect" });
    }
  };
}

export function connectionRoutes(ctx: Ctx) {
  const r = Router();

  r.get("/connections", async (_req, res) => {
    const rows = await ctx.store().list<ConnectionRow>("connections", {}, { limit: 20 });
    res.json({
      encryption: Boolean(secretOf(ctx) && secretOf(ctx).length >= 32),
      categories: CATEGORIES.map((category) => ({
        category,
        connection: rows.find((x) => x.category === category) ? shown(rows.find((x) => x.category === category)!) : null,
        providers: CONNECTORS.filter((c) => c.category === category).map((c) => ({ id: c.id, label: c.label, by: c.by ?? null, blurb: c.blurb, method: c.method, fields: c.fields ?? [], ...oauthReady(ctx.env, c) })),
      })),
    });
  });

  // API key or server login: check it works, then keep it.
  r.post("/connections/:provider", async (req, res) => {
    const who = mustOwn(ctx);
    const c = connector(req.params.provider);
    if (!c || c.method !== "fields" || !c.build) throw new HttpError(c?.method === "soon" ? 409 : 404, c?.method === "soon" ? `${c.label} is coming soon` : "Unknown connection");
    const shape = Object.fromEntries((c.fields ?? []).map((f) => {
      let s = z.string().trim().max(4000);
      if (f.pattern) s = s.regex(new RegExp(f.pattern), f.hint ?? `${f.label} doesn't look right`);
      return [f.name, f.optional ? z.union([z.literal(""), s]).optional() : s.min(1, `${f.label} is required`)];
    }));
    const creds = Object.fromEntries(Object.entries(z.object(shape).parse(req.body ?? {}) as Record<string, string | undefined>).filter(([, v]) => v)) as Record<string, string>;
    if (creds.url) creds.url = z.string().url("Server URL must start with https://").parse(creds.url).replace(/\/$/, "");
    let detail: string, built: { model?: string };
    try {
      built = c.build(ctx.env, creds) as { model?: string };
      detail = await check(c.category, built);
    } catch (e) {
      throw new HttpError(422, `${c.label} didn't accept that: ${e instanceof Error ? e.message : String(e)}`);
    }
    const account = creds.url ? new URL(creds.url).host : c.category === "ai" && built.model ? `${c.label} · ${built.model}` : `${c.label} account`;
    const row = await save(ctx, c, account, creds, who);
    res.status(201).json({ connection: shown(row!), detail });
  });

  // Veltra: one click gives the Veltra account signed in with the owner's own
  // email a key that works only inside this company. Matching verified
  // emails is what keeps one company from linking itself into someone
  // else's Veltra.
  r.post("/connections/veltra/link", async (req, res) => {
    const who = mustOwn(ctx);
    if (ctx.caller()?.kind !== "user") throw new HttpError(403, "Sign in as the owner to link Veltra");
    const c = connector("veltra")!;
    const ready = oauthReady(ctx.env, c);
    if (!ready.ready) throw new HttpError(503, `Onixus hasn't set up Veltra yet (needs ${ready.missing.join(", ")})`);
    const key = `${COMPANY_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const store = ctx.store();
    const minted = await store.insert<{ id: string }>("api_keys", { label: "Veltra", hash: keyHash(key), created_by: who.email });
    let account;
    try {
      account = await veltra(ctx.env).link({ email: who.email, api_url: apiBase(ctx, req), api_key: key, org_id: who.orgId });
    } catch (e) {
      await store.remove("api_keys", minted!.id).catch(() => {});
      if (e instanceof ProviderError && e.upstreamStatus === 404) throw new HttpError(422, `No Veltra account uses ${who.email}. Sign in to Veltra with that email at ${veltra(ctx.env).url}, then link again.`);
      throw new HttpError(422, `Veltra didn't accept the link: ${e instanceof Error ? e.message : String(e)}`);
    }
    const before = await rowFor(ctx, "inbox");
    if (before) await unlinkVeltra(ctx, before, who.orgId, false);
    const row = await save(ctx, c, account.mailbox ? `${account.name} · ${account.mailbox}` : account.name, { key_id: minted!.id, account_id: account.id }, who);
    res.status(201).json({ connection: shown(row!), detail: account.mailbox ? `Veltra is working ${account.mailbox} with Onixus` : "Linked. Connect a mailbox in Veltra so it can start" });
  });

  // Sign in at the provider: a signed state carries the company and the person through the round trip.
  r.post("/connections/:provider/start", async (req, res) => {
    const who = mustOwn(ctx);
    const c = connector(req.params.provider);
    if (!c?.oauth) throw new HttpError(404, "This connection doesn't use sign-in");
    const ready = oauthReady(ctx.env, c);
    if (!ready.ready) throw new HttpError(503, `Onixus hasn't set up ${c.label} sign-in yet (needs ${ready.missing.join(", ")})`);
    const redirect = callbackUrl(ctx, req);
    const state = signToken(secretOf(ctx), { org: who.orgId, user: who.email, provider: c.id, redirect, exp: Date.now() + 15 * 60_000 });
    res.json({ url: authorizeUrl(ctx.env, c, redirect, state) });
  });

  r.delete("/connections/:category", async (req, res) => {
    const who = mustOwn(ctx);
    const category = z.enum(CATEGORIES).parse(req.params.category);
    const row = await rowFor(ctx, category);
    if (row?.provider === "veltra") await unlinkVeltra(ctx, row, who.orgId, true);
    if (row) await ctx.store().remove("connections", row.id);
    res.json({ removed: Boolean(row) });
  });

  r.post("/connections/:category/test", async (req, res) => {
    const category = z.enum(CATEGORIES).parse(req.params.category);
    const row = await rowFor(ctx, category);
    if (!row) throw new HttpError(404, "Nothing is connected here");
    try {
      if (row.provider === "veltra") {
        const a = await veltra(ctx.env).account(unseal(secretOf(ctx), row.secret).account_id!);
        if (a.onixus_org !== orgAndUser(ctx).orgId) throw new Error("Veltra is no longer linked to this company; link it again");
        const detail = a.mailbox ? `Veltra is working ${a.mailbox} with Onixus` : "Linked, but Veltra has no mailbox yet: connect one in Veltra";
        await ctx.store().update("connections", row.id, { status: "CONNECTED", last_error: null });
        return res.json({ ok: true, detail });
      }
      const p = await connected(ctx, category);
      if (!p) throw new Error(`${row.provider} isn't available`);
      const detail = category === "email"
        ? (await (p as EmailProvider).send({ to: z.string().email().parse(orgAndUser(ctx).email), subject: "Onixus test email", html: "<p>Your mailbox is connected to Onixus Logistics OS.</p>" }), `Test email sent to ${orgAndUser(ctx).email}`)
        : await check(category, p);
      await ctx.store().update("connections", row.id, { status: "CONNECTED", last_error: null });
      res.json({ ok: true, detail });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await ctx.store().update("connections", row.id, { status: "ERROR", last_error: message.slice(0, 500) });
      res.json({ ok: false, detail: message });
    }
  });

  return r;
}
