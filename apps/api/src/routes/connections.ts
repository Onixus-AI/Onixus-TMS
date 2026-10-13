import { Router, type Request } from "express";
import { z } from "zod";
import {
  authorizeUrl, CATEGORIES, connector, CONNECTORS, exchangeCode, oauthReady, scopedStore, seal, signToken, unseal, verifyToken,
  type Category, type Connector, type CrmProvider, type EmailProvider, type FinanceProvider, type TrackingProvider,
} from "@onixus/providers";
import { HttpError, type Ctx } from "../http.js";

// Each company's own connections: its mailbox, CRM, books and GPS. Owners
// connect and disconnect; everyone in the office sees what is connected.
// Credentials are sealed before they are stored and never sent back.

type ConnectionRow = { id: string; org_id: string; category: Category; provider: string; account: string | null; secret: string; status: "CONNECTED" | "ERROR"; last_error: string | null; connected_by: string | null; created_at: string; updated_at: string };
type Built = { email: EmailProvider; crm: CrmProvider; finance: FinanceProvider; tracking: TrackingProvider };

const secretOf = (ctx: Ctx) => ctx.env.CONNECTIONS_SECRET?.trim() ?? "";

function orgAndUser(ctx: Ctx) {
  const c = ctx.caller();
  const orgId = c?.kind === "system" ? c.orgId : c?.member?.org_id;
  if (!orgId) throw new HttpError(403, "Join or create a company first");
  return { orgId, email: c?.kind === "user" ? c.user.email : "platform", owner: c?.kind === "system" || c?.member?.role === "OWNER" };
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

async function save(ctx: Ctx, c: Connector, account: string, creds: Record<string, string>, who: { email: string }) {
  const store = ctx.store();
  const existing = await rowFor(ctx, c.category);
  const row = { category: c.category, provider: c.id, account, secret: seal(secretOf(ctx), creds), status: "CONNECTED", last_error: null, connected_by: who.email, updated_at: ctx.now().toISOString() };
  return existing ? store.update<ConnectionRow>("connections", existing.id, row) : store.insert<ConnectionRow>("connections", row);
}

const shown = (r: ConnectionRow) => ({ id: r.id, category: r.category, provider: r.provider, account: r.account, status: r.status, last_error: r.last_error, connected_by: r.connected_by, updated_at: r.updated_at });

/** Where the provider sends the person back to: this API's public address. */
function callbackUrl(ctx: Ctx, req: Request) {
  const base = ctx.env.API_PUBLIC_URL?.trim() || (ctx.env.RAILWAY_PUBLIC_DOMAIN ? `https://${ctx.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.protocol}://${req.get("host")}`);
  return `${base.replace(/\/$/, "")}/connections/oauth/callback`;
}
const webOrigin = (ctx: Ctx) => (ctx.env.WEB_ORIGIN ?? "http://localhost:5173").split(",")[0]!.trim();

/** A quick read with the new credentials, so a wrong key is caught at connect time, not on first use. */
async function check(category: Category, provider: unknown) {
  if (category === "tracking") return `${(await (provider as TrackingProvider).positions()).length} vehicle(s) reporting`;
  if (category === "crm") return (await (provider as CrmProvider).searchCompanies("a", 1), "CRM reachable");
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
    const shape = Object.fromEntries((c.fields ?? []).map((f) => [f.name, z.string().trim().min(1, `${f.label} is required`).max(4000)]));
    const creds = z.object(shape).parse(req.body ?? {}) as Record<string, string>;
    if (creds.url) creds.url = z.string().url("Server URL must start with https://").parse(creds.url).replace(/\/$/, "");
    let detail: string;
    try {
      detail = await check(c.category, c.build(ctx.env, creds));
    } catch (e) {
      throw new HttpError(422, `${c.label} didn't accept that: ${e instanceof Error ? e.message : String(e)}`);
    }
    const row = await save(ctx, c, creds.url ? new URL(creds.url).host : `${c.label} account`, creds, who);
    res.status(201).json({ connection: shown(row!), detail });
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
    mustOwn(ctx);
    const category = z.enum(CATEGORIES).parse(req.params.category);
    const row = await rowFor(ctx, category);
    if (row) await ctx.store().remove("connections", row.id);
    res.json({ removed: Boolean(row) });
  });

  r.post("/connections/:category/test", async (req, res) => {
    const category = z.enum(CATEGORIES).parse(req.params.category);
    const row = await rowFor(ctx, category);
    if (!row) throw new HttpError(404, "Nothing is connected here");
    try {
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
