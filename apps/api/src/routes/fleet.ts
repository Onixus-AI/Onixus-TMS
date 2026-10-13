import { Router } from "express";
import { z } from "zod";
import { CONTAINER_SIZES, dispatchProblems, TRAILER_KINDS, TRUCK_KINDS, type DriverLike, type TrailerLike, type TruckLike } from "@onixus/core";
import { defined, HttpError, isoDate, mustGet, notFound, text, today, uuid, type Ctx } from "../http.js";
import { moveLoad, type Load } from "./loads.js";
import { legsOf, legStarted, planLoadLegs, syncLoad, type Leg } from "./legs.js";

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
  // Legs to drive. Naming loads instead takes every planned leg of each.
  leg_ids: z.array(uuid).min(1).max(12).optional(),
  load_ids: z.array(uuid).min(1).max(6).optional(),
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

export type Trip = { id: string; status: (typeof TRIP_STATUSES)[number]; load_ids: string[]; leg_ids?: string[] | null; driver_id: string; truck_id: string; trailer_id?: string | null };

/** Loads that can take a leg: booked or already on the road (a drop's empty comes back after delivery). */
const LEG_READY = new Set(["BOOKED", "PLANNED", "ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED"]);

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
    if (!body.leg_ids && !body.load_ids) throw new HttpError(400, "Pick the legs (or loads) for this trip");
    const store = ctx.store();

    // The legs, and the loads they belong to.
    let legs: Leg[] = [];
    if (body.leg_ids) legs = await Promise.all(body.leg_ids.map((id) => mustGet<Leg>(ctx, "load_legs", id, "Leg")));
    else {
      for (const id of body.load_ids!) {
        const load = await mustGet<Load>(ctx, "loads", id, "Load");
        const planned = (await planLoadLegs(ctx, load)).filter((l) => l.status === "PLANNED");
        if (!planned.length) throw new HttpError(409, `${load.load_number ?? load.id} has no legs left to dispatch`, load.status === "DRAFT" || load.status === "QUOTED" ? ["Book it first"] : undefined);
        legs.push(...planned);
      }
    }
    const loadIds = [...new Set(legs.map((l) => l.load_id))];
    const loads = await Promise.all(loadIds.map((id) => mustGet<Load>(ctx, "loads", id, "Load")));
    const byLoad = new Map(loads.map((l) => [l.id, l]));
    const ref = (l: Leg) => `${byLoad.get(l.load_id)?.load_number ?? l.load_id} leg ${l.seq}`;

    const problems: string[] = [];
    for (const l of legs) if (l.status !== "PLANNED") problems.push(`${ref(l)} is already ${l.status.toLowerCase()}`);
    for (const load of loads) if (!LEG_READY.has(load.status)) problems.push(`${load.load_number ?? load.id} is ${load.status.toLowerCase().replace(/_/g, " ")}; book it first`);
    // Legs run in order: every earlier leg is either on this trip or already assigned.
    const chosen = new Set(legs.map((l) => l.id));
    for (const load of loads) {
      const all = (await legsOf(ctx, load.id)).filter((l) => l.status !== "CANCELED");
      for (const l of all.filter((x) => chosen.has(x.id))) {
        const before = all.filter((x) => x.seq < l.seq && x.status === "PLANNED" && !chosen.has(x.id));
        if (before.length) problems.push(`${ref(l)} comes after leg ${before.map((b) => b.seq).join(", ")}, which is not dispatched yet`);
      }
    }
    if (problems.length) throw new HttpError(409, "These legs cannot go on a trip yet", problems);

    const [drv, trk, trl] = await Promise.all([
      mustGet<DriverLike>(ctx, "drivers", body.driver_id, "Driver"),
      mustGet<TruckLike>(ctx, "trucks", body.truck_id, "Truck"),
      body.trailer_id ? mustGet<TrailerLike>(ctx, "equipment", body.trailer_id, "Trailer") : Promise.resolve(null),
    ]);
    // Weight and hazmat count only where the box is loaded on this trip.
    const freight = loads.map((load) => {
      const carriesIt = legs.some((l) => l.load_id === load.id && l.cargo === "LOADED");
      return { ...load, weight_lbs: carriesIt ? load.weight_lbs : 0, hazmat: carriesIt ? load.hazmat : false };
    });
    const fit = dispatchProblems({ loads: freight, truck: trk, trailer: trl, driver: drv, today: today(ctx) });
    if (fit.length) throw new HttpError(422, "This trip cannot be dispatched", fit);

    const ordered = [...legs].sort((a, b) => (a.load_id === b.load_id ? a.seq - b.seq : 0));
    const trip = await store.insert<Trip>("trips", {
      driver_id: drv.id, truck_id: trk.id, trailer_id: trl?.id ?? null, status: "ASSIGNED", leg_ids: ordered.map((l) => l.id), load_ids: loadIds,
      is_dual_transaction: loads[0].equipment_type === "CONTAINER" && loads.length === 2,
    });
    const taken: Leg[] = [];
    for (const l of ordered) {
      const done = await store.update<Leg>("load_legs", l.id, { status: "ASSIGNED", trip_id: trip.id }, { status: "PLANNED" });
      if (!done) {
        // Another dispatcher took this leg: put the others back.
        for (const t of taken) await store.update("load_legs", t.id, { status: "PLANNED", trip_id: null });
        await store.update("trips", trip.id, { status: "CANCELED" });
        throw new HttpError(409, `${ref(l)} was just dispatched by someone else; reload and try again`);
      }
      taken.push(done);
    }
    const synced = await Promise.all(loadIds.map((id) => syncLoad(ctx, id)));
    await Promise.all([
      store.update("drivers", drv.id, { status: "ON_TRIP" }),
      store.update("trucks", trk.id, { status: "ON_TRIP" }),
      trl ? store.update("equipment", trl.id, { status: "ON_TRIP" }) : null,
    ]);
    res.status(201).json({ trip, legs: taken, loads: synced });
  });

  r.get("/trips", async (req, res) => {
    const q = z.object({ status: z.enum(TRIP_STATUSES).optional() }).parse(req.query);
    res.json({ trips: await ctx.store().list("trips", defined(q), { order: "created_at", limit: 200 }) });
  });

  r.get("/trips/:id", async (req, res) => {
    const trip = await mustGet<Trip>(ctx, "trips", req.params.id, "Trip");
    const [loads, events, legs] = await Promise.all([
      trip.load_ids?.length ? ctx.store().list("loads", { id: trip.load_ids }) : [],
      ctx.store().list("trip_events", { trip_id: trip.id }, { order: "created_at", ascending: true }),
      trip.leg_ids?.length ? ctx.store().list("load_legs", { id: trip.leg_ids }) : [],
    ]);
    res.json({ trip, loads, legs, events });
  });

  r.post("/trips/:id/status", async (req, res) => {
    const { status: to } = z.object({ status: z.enum(["DISPATCHED", "COMPLETED", "CANCELED"]) }).parse(req.body);
    const trip = await mustGet<Trip>(ctx, "trips", req.params.id, "Trip");
    res.json({ trip: await changeTripStatus(ctx, trip, to) });
  });

  // Driver check calls and stop events.
  r.post("/trips/:id/events", async (req, res) => {
    const trip = await mustGet<Trip>(ctx, "trips", req.params.id, "Trip");
    res.status(201).json({ event: await addTripEvent(ctx, trip, req.body) });
  });

  return r;
}


/**
 * Dispatch, complete or cancel a trip, with its loads and equipment.
 * Dispatching moves assigned loads to DISPATCHED; completing needs every
 * load delivered; canceling puts unstarted loads back to BOOKED. Completing
 * or canceling frees the driver, truck and trailer.
 */
export async function changeTripStatus(ctx: Ctx, trip: Trip, to: "DISPATCHED" | "COMPLETED" | "CANCELED") {
  const store = ctx.store();
  const legs = trip.leg_ids?.length ? await store.list<Leg>("load_legs", { id: trip.leg_ids }) : [];
  const now = ctx.now().toISOString();
  const allowed: Record<string, string[]> = { DISPATCHED: ["ASSIGNED"], COMPLETED: ["DISPATCHED"], CANCELED: ["ASSIGNED", "DISPATCHED"] };
  if (!allowed[to].includes(trip.status)) throw new HttpError(409, `A trip cannot go from ${trip.status} to ${to}`);
  const named = async (l: Leg) => `${((await store.get<Load>("loads", l.load_id)) as Load | null)?.load_number ?? l.load_id} leg ${l.seq}`;

  if (to === "COMPLETED") {
    const open = legs.filter((l) => l.status !== "DONE" && l.status !== "CANCELED");
    if (open.length) throw new HttpError(409, "Finish every leg before completing the trip", await Promise.all(open.map(async (l) => `${await named(l)} is ${l.status.toLowerCase().replace(/_/g, " ")}`)));
  }
  if (to === "CANCELED") {
    const rolling = legs.filter(legStarted);
    if (rolling.length) throw new HttpError(409, "A leg on this trip is already under way; finish it or put the load on hold", await Promise.all(rolling.map(async (l) => `${await named(l)} is ${l.status.toLowerCase().replace(/_/g, " ")}`)));
  }
  const updated = await store.update<Trip & { id: string }>("trips", trip.id, { status: to, ...(to === "DISPATCHED" ? { dispatched_at: now } : { completed_at: now }) }, { status: trip.status });
  if (!updated) throw new HttpError(409, "Trip changed while you were working; reload and try again");

  if (to === "DISPATCHED") {
    for (const l of legs) if (l.status === "ASSIGNED") await store.update("load_legs", l.id, { status: "DISPATCHED" }, { status: "ASSIGNED" });
  } else if (to === "CANCELED") {
    for (const l of legs) if (["ASSIGNED", "DISPATCHED"].includes(l.status)) await store.update("load_legs", l.id, { status: "PLANNED", trip_id: null }, { status: l.status });
  }
  for (const loadId of trip.load_ids ?? []) {
    const load = await syncLoad(ctx, loadId);
    // Canceled before anything moved: the load waits for a truck again.
    if (to === "CANCELED" && ["ASSIGNED", "DISPATCHED"].includes(load.status)) {
      const left = (await legsOf(ctx, loadId)).filter((l) => l.status !== "CANCELED" && l.status !== "PLANNED");
      if (!left.length) await moveLoad(ctx, load, "BOOKED", `Trip ${trip.id} canceled`, { system: true });
    }
  }
  if (to !== "DISPATCHED") {
    await Promise.all([
      store.update("drivers", trip.driver_id, { status: "AVAILABLE" }),
      store.update("trucks", trip.truck_id, { status: "AVAILABLE" }),
      trip.trailer_id ? store.update("equipment", trip.trailer_id, { status: "AVAILABLE" }) : null,
    ]);
  }
  return updated;
}

/** A check call, arrival, delay or note on a trip, optionally with the phone's position. */
export async function addTripEvent(ctx: Ctx, trip: Trip, body: unknown) {
  const e = tripEvent.parse(body);
  return ctx.store().insert("trip_events", { trip_id: trip.id, event_type: e.event_type, lat: e.lat ?? null, lng: e.lng ?? null, metadata: e.note ? { note: e.note } : null, created_at: ctx.now().toISOString() });
}
