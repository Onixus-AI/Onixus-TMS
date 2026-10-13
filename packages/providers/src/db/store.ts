import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import type { Env } from "../env.js";

// The four table operations the API needs. Supabase in production; an
// in-memory copy for tests and local demos. Keeping the surface this small
// is what lets the two behave the same.

export type Row = Record<string, unknown> & { id: string };
type Scalar = string | number | boolean | null;
/** Column filters: a value means "equals", null means "is null", an array means "is one of". */
export type Where = Record<string, Scalar | readonly Scalar[]>;
export type ListOptions = { limit?: number; order?: string; ascending?: boolean };

export interface Store {
  list<T extends Row = Row>(table: string, where?: Where, opts?: ListOptions): Promise<T[]>;
  get<T extends Row = Row>(table: string, id: string): Promise<T | null>;
  insert<T extends Row = Row>(table: string, row: Record<string, unknown>): Promise<T>;
  /** Update one row. With `expect`, only when those columns still hold those values; returns null otherwise (someone else changed it). */
  update<T extends Row = Row>(table: string, id: string, patch: Record<string, unknown>, expect?: Where): Promise<T | null>;
  /** Delete one row; false when it was not there. */
  remove(table: string, id: string): Promise<boolean>;
}

/** A database error with the HTTP status it should surface as. */
export class StoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Postgres error codes worth telling the caller about.
const PG_STATUS: Record<string, number> = { "23505": 409, "23503": 400, "23514": 400, "22P02": 400, "23502": 400 };

function fail(error: { code?: string; message: string }): never {
  throw new StoreError(PG_STATUS[error.code ?? ""] ?? 502, `Database: ${error.message}`);
}

function applyWhere<Q extends { eq: Function; is: Function; in: Function }>(q: Q, where: Where = {}): Q {
  for (const [col, v] of Object.entries(where)) {
    if (Array.isArray(v)) q = q.in(col, v);
    else if (v === null) q = q.is(col, null);
    else q = q.eq(col, v);
  }
  return q;
}

export function supabaseStore(client: SupabaseClient): Store {
  return {
    async list<T extends Row>(table: string, where?: Where, opts: ListOptions = {}) {
      let q = applyWhere(client.from(table).select("*"), where);
      if (opts.order) q = q.order(opts.order, { ascending: opts.ascending ?? false });
      const { data, error } = await q.limit(opts.limit ?? 200);
      if (error) fail(error);
      return data as T[];
    },
    async get<T extends Row>(table: string, id: string) {
      const { data, error } = await client.from(table).select("*").eq("id", id).maybeSingle();
      if (error) fail(error);
      return data as T | null;
    },
    async insert<T extends Row>(table: string, row: Record<string, unknown>) {
      const { data, error } = await client.from(table).insert(row).select("*").single();
      if (error) fail(error);
      return data as T;
    },
    async update<T extends Row>(table: string, id: string, patch: Record<string, unknown>, expect?: Where) {
      const { data, error } = await applyWhere(client.from(table).update(patch).eq("id", id), expect).select("*").maybeSingle();
      if (error) fail(error);
      return data as T | null;
    },
    async remove(table: string, id: string) {
      const { data, error } = await client.from(table).delete().eq("id", id).select("id");
      if (error) fail(error);
      return (data ?? []).length > 0;
    },
  };
}

export const storeFromEnv = (env: Env): Store => supabaseStore(supabase(env));

/** Shared reference data every organization reads; everything else belongs to one organization. */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set(["container_status", "port_terminals"]);

/**
 * The same store, limited to one organization: every read filters on
 * org_id, every insert stamps it, a row of another organization reads as
 * missing, and org_id itself can never be changed.
 */
export function scopedStore(base: Store, orgId: string): Store {
  const global = (table: string) => GLOBAL_TABLES.has(table);
  const withoutOrg = (row: Record<string, unknown>) => {
    const { org_id: _ignored, ...rest } = row;
    return rest;
  };
  return {
    list: (table, where = {}, opts) => base.list(table, global(table) ? where : { ...where, org_id: orgId }, opts),
    async get<T extends Row>(table: string, id: string) {
      const row = await base.get<T>(table, id);
      return row && (global(table) || row.org_id === orgId) ? row : null;
    },
    insert: (table, row) => base.insert(table, global(table) ? row : { ...withoutOrg(row), org_id: orgId }),
    update: (table, id, patch, expect) => base.update(table, id, withoutOrg(patch), global(table) ? expect : { ...expect, org_id: orgId }),
    async remove(table, id) {
      if (global(table)) return false;
      const row = await base.get(table, id);
      return row?.org_id === orgId ? base.remove(table, id) : false;
    },
  };
}

const matches = (row: Record<string, unknown>, where: Where = {}) =>
  Object.entries(where).every(([col, v]) => (Array.isArray(v) ? v.includes(row[col] as Scalar) : v === null ? row[col] == null : row[col] === v));

/** In-memory store with the same semantics, for tests and running without a database. */
export function memoryStore(seed: Record<string, Row[]> = {}): Store & { tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const rows = (t: string) => (tables[t] ??= []);
  let tick = 0;
  return {
    tables,
    async list<T extends Row>(table: string, where?: Where, opts: ListOptions = {}) {
      let out = rows(table).filter((r) => matches(r, where));
      if (opts.order) {
        const col = opts.order, dir = opts.ascending ?? false ? 1 : -1;
        out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -dir : String(a[col] ?? "") > String(b[col] ?? "") ? dir : 0));
      }
      return out.slice(0, opts.limit ?? 200).map((r) => ({ ...r })) as T[];
    },
    async get<T extends Row>(table: string, id: string) {
      const r = rows(table).find((x) => x.id === id);
      return (r ? { ...r } : null) as T | null;
    },
    async insert<T extends Row>(table: string, row: Record<string, unknown>) {
      // Strictly increasing timestamps so "newest first" is deterministic.
      const created = new Date(Date.UTC(2026, 0, 1) + ++tick * 1000).toISOString();
      const r = { id: randomUUID(), created_at: created, ...row } as Row;
      rows(table).push(r);
      return { ...r } as T;
    },
    async update<T extends Row>(table: string, id: string, patch: Record<string, unknown>, expect?: Where) {
      const r = rows(table).find((x) => x.id === id);
      if (!r || !matches(r, expect)) return null;
      Object.assign(r, patch);
      return { ...r } as T;
    },
    async remove(table: string, id: string) {
      const i = rows(table).findIndex((x) => x.id === id);
      if (i < 0) return false;
      rows(table).splice(i, 1);
      return true;
    },
  };
}
