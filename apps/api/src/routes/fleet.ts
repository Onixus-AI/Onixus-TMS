import { Router } from "express";
import { z } from "zod";
import { CONTAINER_SIZES, dispatchProblems, DISPATCHABLE, FINISHED, TRAILER_KINDS, TRUCK_KINDS, type DriverLike, type TrailerLike, type TruckLike } from "@onixus/core";
import { defined, HttpError, isoDate, mustGet, notFound, text, today, uuid, type Ctx } from "../http.js";
import { moveLoad, type Load } from "./loads.js";

export const ASSET_STATUSES = ["AVAILABLE", "ON_TRIP", "OFF_DUTY", "OUT_OF_SERVICE"] as const;
export const TRIP_STATUSES = ["ASSIGNED", "DISPATCHED", "COMPLETED", "CANCELED"] as const;

const status = z.enum(ASSET_STATUSES);
const chassisSize = new RegExp(`^(${CONTAINER_SIZES.join("|")})(/(${CONTAINER_SIZES.join("|")}))?$`);

const driver = z.object({
  name: text(),
  phone: text(40).nullish(),
  email: z.string().email().nullish(),
  license_number: text(40).nullish(),
  license_expiry: isoDate.nullish(),
  cdl_class: z.enum(["A", "B", "C"]).nullish(),
  medical_card_expiry: isoDate.nullish(),
  twic_expiry: isoDate.nullish(),
  hazmat_endorsement: z.boolean().optional(),
  status: status.optional(),
});
const truck = z.object({
  truck_number: text(40),
  kind: z.enum(TRUCK_KINDS).default("TRACTOR"),
  vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/i, "A VIN is 17 characters").nullish(),
  plate: text(20).nullish(),
  gvwr_lbs: z.number().int().positive().max(200_000).nullish(),
  max_payload_lbs: z.number().int().positive().max(200_000).nullish(),
  tracking_device_id: text(100).nullish(),
  status: status.optional(),
});
const trailer = z.object({
  unit_number: text(40),
  kind: z.enum(TRAILER_KINDS).default("CHASSIS"),
  size: text(10).nullish(),
  type: text(40).nullish(),
  pool: text(40).nullish(),
  plate: text(20).nullish(),
  max_payload_lbs: z.number().int().positive().max(200_000).nullish(),
  status: status.optional(),
});
const chassisCheck = (t: { kind?: string; size?: string | null }) => t.kind !== "CHASSIS" || !t.size || chassisSize.test(t.size);
const chassisMessage = { message: "Chassis size is 20, 40, 45, 20/40 or 40/45", path: ["size"] };

// Trailers live in the `equipment` table (chassis, flatbed and dry van trailers).
const ASSETS = {
  drivers: { table: "drivers", what: "Driver", create: driver, patch: driver.partial() },
  trucks: { table: "trucks", what: "Truck", create: truck, patch: truck.partial() },
  trailers: { table: "equipment", what: "Trailer", create: trailer.refine(chassisCheck, chassisMessage), patch: trailer.partial().refine(chassisCheck, chassisMessage) },
} as const;

const dispatch = z.object({
  load_ids: z.array(uuid).min(1).max(6),
  driver_id: uuid,
  truck_id: uuid,
  trailer_id: uuid.nullish(),
});
const tripEvent = z.object({
  event_type: z.enum(["CHECK_CALL", "ARRIVED", "DEPARTED", "DELAY", "BREAKDOWN", "NOTE"]),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  note: text(1000).optional(),
});

type Trip = { id: string; status: (typeof TRIP_STATUSES)[number]; load_ids: string[]; driver_id: string; truck_id: string; trailer_id?: string | null };

export function fleetRoutes(ctx: Ctx) {
  const r = Router();

  for (const [path, a] of Object.entries(ASSETS)) {
    r.get(`/${path}`, async (req, res) => {
      const q = z.object({ status: status.optional(), kind: z.string().max(20).optional() }).parse(req.query);
      res.json({ [path]: await ctx.store().list(a.table, defined(q), { order: "id", ascending: true, limit: 500 }) });
    });
    r.post(`/${path}`, async (req, res) => {
      const row = a.create.parse(req.body);
      res.status(201).json({ [path.slice(0, -1)]: await ctx.store().insert(a.table, { status: "AVAILABLE", ...defined(row) }) });
    });
    r.patch(`/${path}/:id`, async (req, res) => {
      const id = uuid.parse(req.params.id);
      const patch = defined(a.patch.parse(req.body));
      const row = await ctx.store().update(a.table, id, patch);
      if (!row) throw notFound(a.what);
      res.json({ [path.slice(0, -1)]: row });
    });
  }

  /**
   * Put one or more loads on a driver, truck and (when the freight needs one)
   * trailer. Refuses with the full list of problems: wrong truck for the
   * freight, wrong or busy trailer, chassis too short, over payload, missing
   * CDL / medical card / hazmat endorsement / TWIC.
   */
  r.post("/dispatch", async (req, res) => {
    const body = dispatch.parse(req.body);
    const loads = await Promise.all(body.load_ids.map((id) => mustGet<Load>(ctx, "loads", id, "Load")));
    const notReady = loads.filter((l) => !DISPATCHABLE.includes(l.status));
    if (notReady.length) throw new HttpError(409, "Only booked loads can be dispatched", notReady.map((l) => `${l.load_number ?? l.id} is ${l.status}`));
    const [drv, trk, trl] = await Promise.all([
      mustGet<DriverLike>(ctx, "drivers", body.driver_id, "Driver"),
      mustGet<TruckLike>(ctx, "trucks", body.truck_id, "Truck"),
      body.trailer_id ? mustGet<TrailerLike>(ctx, "equipment", body.trailer_id, "Trailer") : Promise.resolve(null),
    ]);
    const problems = dispatchProblems({ loads, truck: trk, trailer: trl, driver: drv, today: today(ctx) });
    if (problems.length) throw new HttpError(422, "This trip cannot be dispatched", problems);

    const store = ctx.store();
    const trip = await store.insert<Trip>("trips", {
      driver_id: drv.id, truck_id: trk.id, trailer_id: trl?.id ?? null, status: "ASSIGNED", load_ids: loads.map((l) => l.id),
      is_dual_transaction: loads[0].equipment_type === "CONTAINER" && loads.length === 2,
    });
    const moved: Load[] = [];
    try {
      for (const l of loads) moved.push(await moveLoad(ctx, l, "ASSIGNED", `Trip ${trip.id}`));
    } catch (e) {
      // Another dispatcher took one of these loads: put the others back.
      for (const l of moved) await moveLoad(ctx, l, "BOOKED", "Dispatch rolled back", { system: true });
      await store.update("trips", trip.id, { status: "CANCELED" });
      throw e;
    }
    await Promise.all([
      store.update("drivers", drv.id, { status: "ON_TRIP" }),
      store.update("trucks", trk.id, { status: "ON_TRIP" }),
      trl ? store.update("equipment", trl.id, { status: "ON_TRIP" }) : null,
    ]);
    res.status(201).json({ trip, loads: moved });
  });

  r.get("/trips", async (req, res) => {
    const q = z.object({ status: z.enum(TRIP_STATUSES).optional() }).parse(req.query);
    res.json({ trips: await ctx.store().list("trips", defined(q), { order: "created_at", limit: 200 }) });
  });

  r.get("/trips/:id", async (req, res) => {
    const trip = await mustGet<Trip>(ctx, "trips", req.params.id, "Trip");
    const [loads, events] = await Promise.all([
      trip.load_ids?.length ? ctx.store().list("loads", { id: trip.load_ids }) : [],
      ctx.store().list("trip_events", { trip_id: trip.id }, { order: "created_at", ascending: true }),
    ]);
    res.json({ trip, loads, events });
  });

  r.post("/trips/:id/status", async (req, res) => {
    const { status: to } = z.object({ status: z.enum(["DISPATCHED", "COMPLETED", "CANCELED"]) }).parse(req.body);
    const trip = await mustGet<Trip>(ctx, "trips", req.params.id, "Trip");
    const store = ctx.store();
    const loads = trip.load_ids?.length ? await store.list<Load>("loads", { id: trip.load_ids }) : [];
    const now = ctx.now().toISOString();
    const allowed: Record<string, string[]> = { DISPATCHED: ["ASSIGNED"], COMPLETED: ["DISPATCHED"], CANCELED: ["ASSIGNED", "DISPATCHED"] };
    if (!allowed[to].includes(trip.status)) throw new HttpError(409, `A trip cannot go from ${trip.status} to ${to}`);

    if (to === "DISPATCHED") {
      for (const l of loads) if (l.status === "ASSIGNED") await moveLoad(ctx, l, "DISPATCHED", `Trip ${trip.id} dispatched`);
    } else if (to === "COMPLETED") {
      const open = loads.filter((l) => !FINISHED.includes(l.status));
      if (open.length) throw new HttpError(409, "Deliver every load before completing the trip", open.map((l) => `${l.load_number ?? l.id} is ${l.status}`));
    } else {
      const rolling = loads.filter((l) => !["ASSIGNED", "DISPATCHED"].includes(l.status) && !FINISHED.includes(l.status));
      if (rolling.length) throw new HttpError(409, "A load on this trip is already moving; put it on hold instead", rolling.map((l) => `${l.load_number ?? l.id} is ${l.status}`));
      for (const l of loads) if (["ASSIGNED", "DISPATCHED"].includes(l.status)) await moveLoad(ctx, l, "BOOKED", `Trip ${trip.id} canceled`, { system: true });
    }
    const updated = await store.update("trips", trip.id, { status: to, ...(to === "DISPATCHED" ? { dispatched_at: now } : { completed_at: now }) }, { status: trip.status });
    if (!updated) throw new HttpError(409, "Trip changed while you were working; reload and try again");
    if (to !== "DISPATCHED") {
      await Promise.all([
        store.update("drivers", trip.driver_id, { status: "AVAILABLE" }),
        store.update("trucks", trip.truck_id, { status: "AVAILABLE" }),
        trip.trailer_id ? store.update("equipment", trip.trailer_id, { status: "AVAILABLE" }) : null,
      ]);
    }
    res.json({ trip: updated });
  });

  // Driver check calls and stop events.
  r.post("/trips/:id/events", async (req, res) => {
    const e = tripEvent.parse(req.body);
    const trip = await mustGet<Trip>(ctx, "trips", req.params.id, "Trip");
    const row = await ctx.store().insert("trip_events", { trip_id: trip.id, event_type: e.event_type, lat: e.lat ?? null, lng: e.lng ?? null, metadata: e.note ? { note: e.note } : null });
    res.status(201).json({ event: row });
  });

  return r;
}

