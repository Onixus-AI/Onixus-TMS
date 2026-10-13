import { Router } from "express";
import { z } from "zod";
import { CONTAINER_SIZES, EQUIPMENT_LABELS, EQUIPMENT_TYPES, BILLABLE, type EquipmentType } from "@onixus/core";
import { defined, HttpError, isoDate, money, mustGet, text, today, uuid, type Ctx } from "../http.js";
import { charges, moveLoad, type Load } from "./loads.js";

export const CUSTOMER_TYPES = ["SHIPPER", "MANUFACTURER", "BROKER", "FREIGHT_FORWARDER", "STEAMSHIP_LINE", "DEPOT", "WAREHOUSE", "PORT_TERMINAL", "CHASSIS_POOL"] as const;

const customer = z.object({
  type: z.enum(CUSTOMER_TYPES),
  company_name: text(),
  dba_name: text().nullish(),
  mc_number: z.string().regex(/^\d{1,8}$/, "MC number is digits only").nullish(),
  dot_number: z.string().regex(/^\d{1,8}$/, "DOT number is digits only").nullish(),
  scac_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/, "SCAC is 2-4 capital letters").nullish(),
  credit_limit: money.optional(),
  payment_terms: text(40).optional(),
  brokerage_commission_pct: z.number().min(0).max(100).nullish(),
  notes: text(2000).nullish(),
});
const location = z.object({
  label: text(),
  address: text(300).nullish(),
  city: text(100).nullish(),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Two-letter state").nullish(),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, "ZIP is 5 or 9 digits").nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  free_time_days: z.number().int().min(0).max(30).optional(),
});
const terminal = z.object({ name: text(), code: text(20).nullish(), region: text(60).nullish(), lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish() });
const tariff = z.object({
  customer_id: uuid.nullish(),
  origin: text(),
  destination: text(),
  equipment_type: z.enum(EQUIPMENT_TYPES).default("CONTAINER"),
  container_size: z.enum(CONTAINER_SIZES).nullish(),
  steamship_line: text(60).nullish(),
  base_rate: money,
  /** Percent of the base rate. */
  fuel_surcharge: z.number().min(0).max(100).default(0),
  accessorials: z.array(z.object({ code: text(30), description: text(), amount: money })).max(50).optional(),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
});
const quote = z.object({ customer_id: uuid.optional(), origin: text(), destination: text(), equipment_type: z.enum(EQUIPMENT_TYPES).default("CONTAINER"), container_size: z.enum(CONTAINER_SIZES).optional() });
const line = z.object({ code: text(30), description: text(), amount: z.number().min(-1_000_000).max(1_000_000) });
const invoiceRequest = z.object({ accessorials: z.array(line).max(50).default([]), include_container_charges: z.boolean().default(true) });

type Customer = { id: string; org_id?: string | null; dot_number?: string | null; fmcsa_last_checked?: string | null };
type Tariff = z.infer<typeof tariff> & { id: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const cents = (n: number) => Math.round(n * 100) / 100;

export function accountRoutes(ctx: Ctx) {
  const r = Router();

  // ── Customers (shippers, brokers, steamship lines, depots, …) ──────────────
  r.get("/customers", async (req, res) => {
    const q = z.object({ type: z.enum(CUSTOMER_TYPES).optional() }).parse(req.query);
    res.json({ customers: await ctx.store().list("customers", defined(q), { order: "company_name", ascending: true, limit: 500 }) });
  });
  r.post("/customers", async (req, res) => {
    res.status(201).json({ customer: await ctx.store().insert("customers", { compliance_status: "PENDING", ...defined(customer.parse(req.body)) }) });
  });
  r.get("/customers/:id", async (req, res) => {
    const c = await mustGet(ctx, "customers", req.params.id, "Customer");
    const [locations, contacts, fmcsa] = await Promise.all([
      ctx.store().list("customer_locations", { customer_id: c.id }),
      ctx.store().list("customer_contacts", { customer_id: c.id }),
      ctx.store().list("fmcsa_snapshots", { customer_id: c.id }, { order: "created_at", limit: 5 }),
    ]);
    res.json({ customer: c, locations, contacts, fmcsa });
  });
  r.patch("/customers/:id", async (req, res) => {
    const c = await mustGet(ctx, "customers", req.params.id, "Customer");
    res.json({ customer: await ctx.store().update("customers", c.id, defined(customer.partial().parse(req.body))) });
  });
  r.post("/customers/:id/locations", async (req, res) => {
    const c = await mustGet(ctx, "customers", req.params.id, "Customer");
    const l = location.parse(req.body);
    if ((l.lat == null) !== (l.lng == null)) throw new HttpError(400, "Give both latitude and longitude, or neither");
    res.status(201).json({ location: await ctx.store().insert("customer_locations", { customer_id: c.id, ...defined(l) }) });
  });
  r.get("/locations", async (_req, res) => {
    res.json({ locations: await ctx.store().list("customer_locations", {}, { order: "label", ascending: true, limit: 1000 }) });
  });

  r.get("/terminals", async (_req, res) => {
    res.json({ terminals: await ctx.store().list("port_terminals", {}, { order: "name", ascending: true, limit: 500 }) });
  });

  // ── FMCSA: is this broker or carrier allowed to operate? ──────────────────
  r.get("/fmcsa/carriers/:dot", async (req, res) => {
    const dot = z.string().regex(/^\d{1,8}$/).parse(req.params.dot);
    res.json(await ctx.checkCarrier(dot));
  });

  r.post("/customers/:id/fmcsa-check", async (req, res) => {
    res.json(await checkCustomer(ctx, await mustGet<Customer>(ctx, "customers", req.params.id, "Customer")));
  });


  // ── Rates ─────────────────────────────────────────────────────────────────
  r.get("/tariffs", async (_req, res) => {
    res.json({ tariffs: await ctx.store().list("rate_tariffs", {}, { order: "effective_from", limit: 1000 }) });
  });
  r.post("/tariffs", async (req, res) => {
    res.status(201).json({ tariff: await ctx.store().insert("rate_tariffs", defined(tariff.parse(req.body))) });
  });

  /** Price a lane from the tariffs: the customer's own rate wins over the general one. */
  r.post("/quotes", async (req, res) => {
    const q = quote.parse(req.body);
    const day = today(ctx);
    const found = (await ctx.store().list<Tariff>("rate_tariffs", { equipment_type: q.equipment_type }, { limit: 2000 })).filter(
      (t) => same(t.origin, q.origin) && same(t.destination, q.destination)
        && (!t.container_size || !q.container_size || t.container_size === q.container_size)
        && t.effective_from <= day && (!t.effective_to || t.effective_to >= day)
        && (!t.customer_id || t.customer_id === q.customer_id),
    );
    const best = found.find((t) => t.customer_id && t.customer_id === q.customer_id) ?? found.find((t) => !t.customer_id);
    if (!best) throw new HttpError(404, `No ${EQUIPMENT_LABELS[q.equipment_type as EquipmentType]} rate from ${q.origin} to ${q.destination}`);
    const fuel = cents((best.base_rate * (best.fuel_surcharge ?? 0)) / 100);
    res.json({ tariff_id: best.id, base_rate: best.base_rate, fuel_surcharge: fuel, total: cents(best.base_rate + fuel), optional_accessorials: best.accessorials ?? [] });
  });

  // ── Invoices ──────────────────────────────────────────────────────────────
  r.get("/invoices", async (req, res) => {
    const q = z.object({ status: z.enum(["DRAFT", "SENT", "PAID", "VOID"]).optional() }).parse(req.query);
    res.json({ invoices: await ctx.store().list("invoices", defined(q), { order: "created_at", limit: 500 }) });
  });

  /** Bill a delivered load: line haul, any accessorials, and the container's demurrage and per diem. */
  r.post("/loads/:id/invoice", async (req, res) => {
    const body = invoiceRequest.parse(req.body ?? {});
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    if (!BILLABLE.includes(load.status)) throw new HttpError(409, `Only delivered loads can be invoiced; this one is ${load.status}`);
    if (load.rate == null) throw new HttpError(422, "Set the load's rate before invoicing");
    const existing = (await ctx.store().list<{ id: string; status: string }>("invoices", { load_id: load.id })).filter((i) => i.status !== "VOID");
    if (existing.length) throw new HttpError(409, "This load already has an invoice");

    const lines = [{ code: "LINEHAUL", description: `${EQUIPMENT_LABELS[load.equipment_type]} ${load.load_number ?? ""}`.trim(), amount: load.rate }, ...body.accessorials];
    const c = charges(load, ctx.now());
    if (c && body.include_container_charges) {
      if (c.demurrage.amount > 0) lines.push({ code: "DEMURRAGE", description: `Demurrage, ${c.demurrage.days} day(s)`, amount: c.demurrage.amount });
      if (c.perDiem.amount > 0) lines.push({ code: "PER_DIEM", description: `Per diem, ${c.perDiem.days} day(s)`, amount: c.perDiem.amount });
    }
    const amount = cents(lines.reduce((s, l) => s + l.amount, 0));
    const invoice = await ctx.store().insert("invoices", { load_id: load.id, customer_id: load.customer_id ?? null, amount, accessorials: lines, status: "DRAFT" });
    const moved = await moveLoad(ctx, load, "INVOICED", `Invoice ${invoice.id}`);
    res.status(201).json({ invoice, load: moved });
  });

  return r;
}

export async function checkCustomer(ctx: Ctx, c: Customer) {
  if (!c.dot_number) throw new HttpError(400, "Customer has no DOT number");
  const check = await ctx.checkCarrier(c.dot_number);
  const now = ctx.now().toISOString();
  await ctx.store().insert("fmcsa_snapshots", {
    org_id: c.org_id ?? null, customer_id: c.id, dot_number: c.dot_number, snapshot: check.raw, operating_status: check.status,
    safety_rating: (check.raw.safetyRating as string) ?? null, insurance_on_file: check.raw.bipdInsuranceOnFile != null ? Number(check.raw.bipdInsuranceOnFile) > 0 : null,
  });
  await ctx.store().update("customers", c.id, { compliance_status: check.status, fmcsa_last_checked: now });
  return check;
}

/** Platform jobs: shared port terminals, and the daily FMCSA re-check across every company. */
export function platformAccountRoutes(ctx: Ctx) {
  const r = Router();
  r.post("/terminals", async (req, res) => {
    res.status(201).json({ terminal: await ctx.db().insert("port_terminals", defined(terminal.parse(req.body))) });
  });

  /** Re-check every customer with a DOT number not checked in `older_than_days`. Call it daily from a scheduler. */
  r.post("/fmcsa/recheck", async (req, res) => {
    const { older_than_days, limit } = z.object({ older_than_days: z.number().int().min(0).max(365).default(7), limit: z.number().int().min(1).max(200).default(50) }).parse(req.body ?? {});
    const cutoff = ctx.now().getTime() - older_than_days * 86_400_000;
    const due = (await ctx.db().list<Customer>("customers", {}, { limit: 2000 }))
      .filter((c) => c.dot_number && (!c.fmcsa_last_checked || Date.parse(c.fmcsa_last_checked) < cutoff))
      .slice(0, limit);
    const results = [];
    for (const c of due) {
      try {
        const check = await checkCustomer(ctx, c);
        results.push({ customer_id: c.id, status: check.status, reasons: check.reasons });
      } catch (e) {
        results.push({ customer_id: c.id, error: (e as Error).message });
      }
    }
    res.json({ checked: results.length, results });
  });
  return r;
}
