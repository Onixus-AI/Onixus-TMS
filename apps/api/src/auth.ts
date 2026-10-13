import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { scopedStore, type AuthUser, type Store } from "@onixus/providers";
import { defined, HttpError, mustGet, ROLES, text, uuid, type Caller, type Ctx, type Member, type Role } from "./http.js";

// Two ways in:
//  - a person signed in with Supabase Auth sends their access token and acts
//    inside their own organization, with their role's permissions;
//  - the platform (Onixus itself, cron jobs, n8n) sends TMS_API_KEY; with an
//    X-Org-Id header it acts inside that organization, without one it can
//    reach only the platform routes.
// The caller is kept in AsyncLocalStorage so ctx.store() is scoped to the
// right organization in every route without passing it around.

const callerStore = new AsyncLocalStorage<Caller>();
export const currentCaller = () => callerStore.getStore();

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The store limited to the caller's organization; unscoped only for the platform without an organization, and for public routes. */
export function scopedFor(base: () => Store): () => Store {
  return () => {
    const c = callerStore.getStore();
    if (!c) return base();
    if (c.kind === "system") return c.orgId ? scopedStore(base(), c.orgId) : base();
    if (!c.member) throw new HttpError(403, "Join or create a company first");
    return scopedStore(base(), c.member.org_id);
  };
}

/** Short cache so a burst of requests checks a token with Supabase once. */
function cachedVerifier(verify: (token: string) => Promise<AuthUser | null>) {
  const cache = new Map<string, { user: AuthUser | null; until: number }>();
  return async (token: string) => {
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.user;
    const user = await verify(token);
    if (cache.size > 5_000) cache.clear();
    cache.set(token, { user, until: Date.now() + 60_000 });
    return user;
  };
}

export async function memberOf(db: Store, userId: string): Promise<Member | null> {
  const [m] = await db.list<Member & { id: string }>("memberships", { user_id: userId }, { limit: 1 });
  return m && !m.disabled_at ? m : null;
}

export function authenticate(ctx: Ctx, apiKey: string) {
  const verify = cachedVerifier(ctx.verifyUser);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return res.status(401).json({ error: "Sign in first" });
    if (sameSecret(token, apiKey)) {
      const header = req.header("x-org-id");
      const orgId = header ? uuid.safeParse(header) : null;
      if (orgId && !orgId.success) return res.status(400).json({ error: "X-Org-Id must be an organization id" });
      return callerStore.run({ kind: "system", orgId: orgId?.data }, next);
    }
    const user = await verify(token);
    if (!user) return res.status(401).json({ error: "Your session expired; sign in again" });
    const m = await memberOf(ctx.db(), user.id);
    callerStore.run({ kind: "user", user, member: m }, next);
  };
}

const deny = (res: Response, status: number, error: string) => res.status(status).json({ error });

/** Platform-only routes: the API key, never a signed-in person. */
export function platformOnly(req: Request, res: Response, next: NextFunction) {
  return currentCaller()?.kind === "system" ? next() : deny(res, 403, "Platform only");
}

/** Members with one of these roles; the platform may act inside an organization it names. */
export function roles(...allowed: Role[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const c = currentCaller();
    if (c?.kind === "system") return c.orgId ? next() : deny(res, 400, "Send X-Org-Id to act inside an organization");
    if (!c || c.kind !== "user") return deny(res, 401, "Sign in first");
    if (!c.member) return deny(res, 403, "Join or create a company first");
    return allowed.includes(c.member.role) ? next() : deny(res, 403, c.member.role === "DRIVER" ? "Drivers use the driver app" : "Your role cannot do this");
  };
}

/** People who drive: drivers, and owners or dispatchers linked to a driver record (owner-operators). */
export function drivers(_req: Request, res: Response, next: NextFunction) {
  const c = currentCaller();
  if (c?.kind !== "user" || !c.member) return deny(res, 403, "Sign in as a driver");
  return c.member.driver_id ? next() : deny(res, 403, "Your account is not linked to a driver yet; ask the owner");
}

const onboarding = z.object({
  company_name: text(),
  kind: z.enum(["COMPANY", "OWNER_OPERATOR"]).default("COMPANY"),
  dot_number: z.string().regex(/^\d{1,8}$/, "DOT number is digits only").optional(),
  mc_number: z.string().regex(/^\d{1,8}$/, "MC number is digits only").optional(),
  // Owner-operators drive their own truck, so they get a driver record too.
  your_name: text().optional(),
  phone: text(40).optional(),
});
const invite = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES), driver_id: uuid.optional() });
const memberPatch = z.object({ role: z.enum(ROLES).optional(), driver_id: uuid.nullable().optional(), disabled: z.boolean().optional() });

type Invitation = { id: string; org_id: string; email: string; role: Role; driver_id: string | null; accepted_at: string | null };

/** Routes for the signed-in person: who am I, start a company, manage the team. */
export function identityRoutes(ctx: Ctx) {
  const r = Router();
  const signedIn = () => {
    const c = currentCaller();
    if (c?.kind !== "user") throw new HttpError(403, "Sign in as a person");
    return c;
  };

  async function profile(user: AuthUser, m: Member | null) {
    const organization = m ? await ctx.db().get("organizations", m.org_id) : null;
    return { user, membership: m, organization };
  }

  // Who am I. A pending invitation for this email is accepted here, on first sign-in.
  r.get("/me", async (_req, res) => {
    const c = signedIn();
    if (c.member) return res.json(await profile(c.user, c.member));
    const db = ctx.db();
    // Emails are stored lower-case; Supabase only signs in people who confirmed theirs.
    const [inv] = await db.list<Invitation & { id: string }>("invitations", { email: c.user.email, accepted_at: null }, { limit: 1 });
    if (!inv) return res.json(await profile(c.user, null));
    const m = await db.insert<Member & { id: string }>("memberships", { org_id: inv.org_id, user_id: c.user.id, email: c.user.email, role: inv.role, driver_id: inv.driver_id });
    await db.update("invitations", inv.id, { accepted_at: ctx.now().toISOString() });
    res.json(await profile(c.user, m));
  });

  // Start a company. Owner-operators also get a driver record so they can run their own trips.
  r.post("/onboarding", async (req, res) => {
    const c = signedIn();
    if (c.member) throw new HttpError(409, "You already belong to a company");
    const body = onboarding.parse(req.body);
    if (body.kind === "OWNER_OPERATOR" && !body.your_name) throw new HttpError(400, "Owner-operators need their own name for the driver record");
    const db = ctx.db();
    const org = await db.insert("organizations", { name: body.company_name, kind: body.kind, dot_number: body.dot_number ?? null, mc_number: body.mc_number ?? null, created_by: c.user.id });
    let driverId: string | null = null;
    if (body.kind === "OWNER_OPERATOR") {
      const d = await scopedStore(db, org.id).insert("drivers", { name: body.your_name, phone: body.phone ?? null, email: c.user.email, status: "AVAILABLE", hazmat_endorsement: false });
      driverId = d.id;
    }
    const m = await db.insert<Member & { id: string }>("memberships", { org_id: org.id, user_id: c.user.id, email: c.user.email, role: "OWNER", driver_id: driverId });
    res.status(201).json(await profile(c.user, m));
  });

  // ── Team (owners) ─────────────────────────────────────────────────────────
  const owners = roles("OWNER");

  r.get("/members", owners, async (_req, res) => {
    const [members, invitations] = await Promise.all([
      ctx.store().list("memberships", {}, { order: "created_at", ascending: true }),
      ctx.store().list("invitations", { accepted_at: null }, { order: "created_at" }),
    ]);
    res.json({ members, invitations });
  });

  r.post("/members/invitations", owners, async (req, res) => {
    const body = invite.parse(req.body);
    if (body.driver_id) await mustGet(ctx, "drivers", body.driver_id, "Driver");
    if (body.role === "DRIVER" && !body.driver_id) throw new HttpError(400, "Pick the driver record this person drives as");
    const [existing] = await ctx.db().list("invitations", { email: body.email, accepted_at: null }, { limit: 1 });
    if (existing) throw new HttpError(409, "This email already has a pending invitation");
    const c = currentCaller();
    const invitation = await ctx.store().insert("invitations", { email: body.email, role: body.role, driver_id: body.driver_id ?? null, invited_by: c?.kind === "user" ? c.user.id : null });
    const web = (ctx.env.WEB_ORIGIN ?? "").split(",")[0]?.trim() || undefined;
    const email = await ctx.inviteUser(body.email, web);
    res.status(201).json({ invitation, email });
  });

  r.patch("/members/:id", owners, async (req, res) => {
    const target = await mustGet<Member>(ctx, "memberships", String(req.params.id), "Member");
    const body = memberPatch.parse(req.body);
    if (body.driver_id) await mustGet(ctx, "drivers", body.driver_id, "Driver");
    const demoting = target.role === "OWNER" && ((body.role && body.role !== "OWNER") || body.disabled);
    if (demoting) {
      const owners = (await ctx.store().list<Member & { id: string }>("memberships", { role: "OWNER" })).filter((m) => !m.disabled_at);
      if (owners.length <= 1) throw new HttpError(409, "A company needs at least one owner");
    }
    const patch = defined({ role: body.role, driver_id: body.driver_id, disabled_at: body.disabled === undefined ? undefined : body.disabled ? ctx.now().toISOString() : null });
    res.json({ member: await ctx.store().update("memberships", target.id, patch) });
  });

  return r;
}

