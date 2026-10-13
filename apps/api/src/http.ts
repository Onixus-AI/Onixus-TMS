import { z } from "zod";
import type { AuthUser, CarrierCheck, Env, FileStore, Store, TrackingProvider } from "@onixus/providers";

export const ROLES = ["OWNER", "DISPATCHER", "DRIVER"] as const;
export type Role = (typeof ROLES)[number];

export type Member = { id: string; org_id: string; user_id: string; email: string; role: Role; driver_id: string | null; disabled_at?: string | null };

/** Who is calling: the platform (API key, optionally acting inside one organization) or a signed-in person. */
export type Caller =
  | { kind: "system"; orgId?: string }
  | { kind: "user"; user: AuthUser; member: Member | null };

/** Everything a route needs, injectable so tests run without Supabase, FMCSA or Traccar. */
export type Ctx = {
  env: Env;
  /** The whole database. Only for code that works across organizations (auth, webhooks, platform jobs). */
  db: () => Store;
  /** The caller's organization only. Routes use this. */
  store: () => Store;
  caller: () => Caller | undefined;
  now: () => Date;
  checkCarrier: (dotNumber: string) => Promise<CarrierCheck>;
  tracking: () => TrackingProvider;
  verifyUser: (token: string) => Promise<AuthUser | null>;
  inviteUser: (email: string, redirectTo?: string) => Promise<"sent" | "existing_user">;
  files: () => FileStore;
};

/** An error with an HTTP status and, optionally, the list of things to fix. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly problems?: string[]) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const text = (max = 200) => z.string().trim().min(1).max(max);
export const money = z.number().nonnegative().max(10_000_000);

export const today = (ctx: Ctx) => ctx.now().toISOString().slice(0, 10);

/** Fetch a row of the caller's organization or 404. */
export async function mustGet<T extends Record<string, unknown>>(ctx: Ctx, table: string, id: string, what: string): Promise<T & { id: string }> {
  const row = await ctx.store().get(table, uuid.parse(id));
  if (!row) throw notFound(what);
  return row as unknown as T & { id: string };
}

/** Drop undefined keys so a PATCH only touches the fields it names. */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The signed-in member, or 403. */
export function member(ctx: Ctx): Member {
  const c = ctx.caller();
  if (c?.kind !== "user" || !c.member) throw new HttpError(403, "Join or create a company first");
  return c.member;
}
