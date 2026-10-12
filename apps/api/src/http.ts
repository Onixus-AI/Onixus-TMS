import { z } from "zod";
import type { CarrierCheck, Env, Store, TrackingProvider } from "@onixus/providers";

/** Everything a route needs, injectable so tests run without Supabase, FMCSA or Traccar. */
export type Ctx = {
  env: Env;
  store: () => Store;
  now: () => Date;
  checkCarrier: (dotNumber: string) => Promise<CarrierCheck>;
  tracking: () => TrackingProvider;
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

/** Fetch a row or 404. */
export async function mustGet<T extends Record<string, unknown>>(ctx: Ctx, table: string, id: string, what: string): Promise<T & { id: string }> {
  const row = await ctx.store().get(table, uuid.parse(id));
  if (!row) throw notFound(what);
  return row as unknown as T & { id: string };
}

/** Drop undefined keys so a PATCH only touches the fields it names. */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
