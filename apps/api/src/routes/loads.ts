import { Router } from "express";
import { z } from "zod";
import {
  bookingProblems, canTransition, CONTAINER_DEFAULTS, CONTAINER_SIZES, CONTAINER_TYPES, containerRisk, demurrage, DIRECTIONS, EQUIPMENT_TYPES,
  FINISHED, LOAD_STATUSES, loadShapeProblems, MOVE_TYPES, normalizeContainerNumber, perDiem, type LoadFields, type LoadStatus,
} from "@onixus/core";
import { defined, HttpError, isoDate, money, mustGet, text, uuid, type Ctx } from "../http.js";
import { listDocuments, recordDocument, uploadUrl } from "./documents.js";
import { extrasFor } from "./overview.js";
import { legsOf, placesFor, planLoadLegs, syncLoad } from "./legs.js";

export type Load = LoadFields & {
  id: string;
  load_number?: string;
  status: LoadStatus;
  last_free_day?: string | null;
  outgated_at?: string | null;
  empty_returned_at?: string | null;
  cutoff_at?: string | null;
  demurrage_per_day?: number | null;
  per_diem_per_day?: number | null;
  per_diem_free_days?: number | null;
  steamship_line_id?: string | null;
  container_type?: string | null;
  street_turn_pair_id?: string | null;
  street_turn_status?: string | null;
  hazmat?: boolean;
  ingated_at?: string | null;
  org_id?: string;
};

const loadFields = z.object({
  equipment_type: z.enum(EQUIPMENT_TYPES),
  customer_id: uuid.nullish(),
  steamship_line_id: uuid.nullish(),
  pickup_location_id: uuid.nullish(),
  delivery_location_id: uuid.nullish(),
  rate: money.nullish(),
  notes: text(2000).nullish(),
  // Freight details (flatbed, dry van, box truck, cargo van).
  commodity: text().nullish(),
  weight_lbs: z.number().int().positive().max(200_000).nullish(),
  pallet_count: z.number().int().min(0).max(100).nullish(),
  length_in: z.number().positive().max(2_000).nullish(),
  width_in: z.number().positive().max(500).nullish(),
  height_in: z.number().positive().max(500).nullish(),
  hazmat: z.boolean().optional(),
  securement: text(500).nullish(),
  oversize_permit: text(60).nullish(),
  booking_number: text(60).nullish(),
  bol_number: text(60).nullish(),
  seal_number: text(60).nullish(),
  // Container (drayage) details.
  container_number: z.string().max(20).transform(normalizeContainerNumber).nullish(),
  container_size: z.enum(CONTAINER_SIZES).nullish(),
  container_type: z.enum(CONTAINER_TYPES).nullish(),
  chassis_number: text(20).nullish(),
  direction: z.enum(DIRECTIONS).nullish(),
  last_free_day: isoDate.nullish(),
  cutoff_at: z.string().datetime({ offset: true }).nullish(),
  demurrage_per_day: money.optional(),
  per_diem_per_day: money.optional(),
  per_diem_free_days: z.number().int().min(0).max(60).optional(),
  // The move: which legs the container makes (packages/core/src/legs.ts).
  move_type: z.enum(MOVE_TYPES).nullish(),
  terminal_id: uuid.nullish(),
  yard_location_id: uuid.nullish(),
  return_terminal_id: uuid.nullish(),
  return_location_id: uuid.nullish(),
  empty_pickup_terminal_id: uuid.nullish(),
  empty_pickup_location_id: uuid.nullish(),
  // From the delivery order.
  vessel: text(80).nullish(),
  voyage: text(40).nullish(),
  vessel_eta: isoDate.nullish(),
  pickup_number: text(60).nullish(),
  customer_reference: text(80).nullish(),
});
const newLoad = loadFields.extend({ equipment_type: z.enum(EQUIPMENT_TYPES).default("CONTAINER") });
const statusChange = z.object({ status: z.enum(LOAD_STATUSES), note: text(500).optional() });
/** Road statuses come from the legs (driver app, or the office tapping a leg), never typed in. */
const ROAD: readonly LoadStatus[] = ["ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED"];
const PLANNABLE: readonly LoadStatus[] = ["BOOKED", "PLANNED"];

function checkShape(load: LoadFields) {
  const problems = loadShapeProblems(load);
  if (problems.length) throw new HttpError(400, "Load is not valid", problems);
}

/**
 * Move a load to a new status, refusing moves the lifecycle does not allow
 * and losing no race: the update only lands if the status is still the one
 * we read. `system` moves (trip cancel) skip the lifecycle check.
 */
export async function moveLoad(ctx: Ctx, load: Load, to: LoadStatus, note?: string, opts: { patch?: Record<string, unknown>; system?: boolean } = {}): Promise<Load> {
  if (!opts.system && !canTransition(load.status, to)) throw new HttpError(409, `A load cannot go from ${load.status} to ${to}`);
  if (to === "BOOKED" && !opts.system) {
    const problems = bookingProblems(load);
    if (problems.length) throw new HttpError(422, "Load is not ready to book", problems);
  }
  const patch: Record<string, unknown> = { status: to, updated_at: ctx.now().toISOString(), ...opts.patch };
  // An import container leaves the terminal when it is picked up: that starts per diem and stops demurrage.
  if (to === "PICKED_UP" && load.equipment_type === "CONTAINER" && load.direction === "IMPORT" && !load.outgated_at) patch.outgated_at = ctx.now().toISOString();
  const updated = await ctx.store().update<Load>("loads", load.id, patch, { status: load.status });
  if (!updated) throw new HttpError(409, `Load ${load.load_number ?? load.id} changed while you were working; reload and try again`);
  await ctx.store().insert("load_events", { load_id: load.id, from_status: load.status, to_status: to, note: note ?? null });
  // Booking plans the legs; coming off hold catches up with legs already driven.
  if (to === "BOOKED") {
    await planLoadLegs(ctx, updated);
    if (load.status === "ON_HOLD") return syncLoad(ctx, load.id);
  }
  return updated;
}

export function charges(load: Load, now: Date) {
  if (load.equipment_type !== "CONTAINER") return null;
  return { demurrage: demurrage(load, now), perDiem: perDiem(load, now), risk: containerRisk(load, now) };
}

export function loadRoutes(ctx: Ctx) {
  const r = Router();

  r.get("/loads", async (req, res) => {
    const q = z.object({
      status: z.string().optional(),
      equipment_type: z.enum(EQUIPMENT_TYPES).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    const statuses = q.status ? z.array(z.enum(LOAD_STATUSES)).parse(q.status.split(",")) : undefined;
    const where = defined({ status: statuses, equipment_type: q.equipment_type });
    const loads = await ctx.store().list<Load>("loads", where, { order: "created_at", limit: q.limit });
    res.json({ loads: loads.map((l) => ({ ...l, charges: charges(l, ctx.now()) })) });
  });

  r.post("/loads", async (req, res) => {
    const load = newLoad.parse(req.body);
    checkShape(load);
    const defaults = { hazmat: false, is_street_turn: false, ...(load.equipment_type === "CONTAINER" ? CONTAINER_DEFAULTS : {}) };
    const row = await ctx.store().insert<Load>("loads", { ...defaults, ...defined(load), status: "DRAFT" });
    await ctx.store().insert("load_events", { load_id: row.id, from_status: null, to_status: "DRAFT", note: "Created" });
    res.status(201).json({ load: row });
  });

  r.get("/loads/:id", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    const [events, legs] = await Promise.all([
      ctx.store().list("load_events", { load_id: load.id }, { order: "created_at", ascending: true }),
      legsOf(ctx, load.id),
    ]);
    const shown = legs.filter((l) => l.status !== "CANCELED");
    res.json({ load, legs: shown, places: await placesFor(ctx, shown), events, charges: charges(load, ctx.now()), extras: await extrasFor(ctx, load, legs) });
  });

  r.patch("/loads/:id", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    const patch = defined(loadFields.partial().parse(req.body));
    if (["CLOSED", "CANCELED"].includes(load.status)) throw new HttpError(409, `Load is ${load.status.toLowerCase()}`);
    if (patch.equipment_type && patch.equipment_type !== load.equipment_type && !["DRAFT", "QUOTED"].includes(load.status)) {
      throw new HttpError(409, "Equipment type can only change before the load is booked");
    }
    checkShape({ ...load, ...patch } as LoadFields);
    const updated = await ctx.store().update<Load>("loads", load.id, { ...patch, updated_at: ctx.now().toISOString() });
    // A changed stop or move replans legs nobody has been assigned yet.
    if (updated && PLANNABLE.includes(updated.status)) await planLoadLegs(ctx, updated);
    res.json({ load: updated });
  });

  r.post("/loads/:id/status", async (req, res) => {
    const { status, note } = statusChange.parse(req.body);
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    if (ROAD.includes(status)) {
      throw new HttpError(409, status === "ASSIGNED" ? "Assign legs through dispatch, which checks the truck, trailer and driver" : "Road updates come from the legs: the driver app, or tap the leg on the load");
    }
    res.json({ load: await moveLoad(ctx, load, status, note) });
  });

  // The empty is back at the terminal or depot: per diem stops.
  r.post("/loads/:id/empty-returned", async (req, res) => {
    const { at } = z.object({ at: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    if (load.equipment_type !== "CONTAINER" || !load.outgated_at) throw new HttpError(409, "Only a container that has left the terminal can be returned");
    if (load.empty_returned_at) throw new HttpError(409, "The empty was already returned");
    const updated = await ctx.store().update<Load>("loads", load.id, { empty_returned_at: at ?? ctx.now().toISOString(), updated_at: ctx.now().toISOString() });
    res.json({ load: updated, charges: charges(updated!, ctx.now()) });
  });

  r.get("/loads/:id/documents", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    res.json({ documents: await listDocuments(ctx, load) });
  });
  r.post("/loads/:id/documents/upload-url", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    res.json(await uploadUrl(ctx, load, req.body));
  });
  r.post("/loads/:id/documents", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    res.status(201).json(await recordDocument(ctx, load, req.body));
  });

  return r;
}

export const isFinished = (l: Load) => FINISHED.includes(l.status);
