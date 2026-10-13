import { Router } from "express";
import { z } from "zod";
import { FINISHED } from "@onixus/core";
import { HttpError, member, mustGet, type Ctx } from "../http.js";
import { moveLoad, type Load } from "./loads.js";
import { addTripEvent, changeTripStatus, type Trip } from "./fleet.js";
import { listDocuments, recordDocument, uploadUrl } from "./documents.js";

// The driver app. A driver sees only trips assigned to their driver record,
// and moves their loads through the road statuses; everything else stays
// with the office.

/** What a driver may tap, in order. */
export const DRIVER_STATUSES = ["AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED"] as const;

type Location = { id: string; label?: string; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; lat?: number | null; lng?: number | null };

export function driverRoutes(ctx: Ctx) {
  const r = Router();

  async function myTrip(id: string): Promise<Trip> {
    const trip = await mustGet<Trip>(ctx, "trips", id, "Trip");
    if (trip.driver_id !== member(ctx).driver_id) throw new HttpError(404, "Trip not found");
    return trip;
  }

  /** A load on one of my dispatched trips. */
  async function myLoad(id: string): Promise<{ load: Load; trip: Trip }> {
    const load = await mustGet<Load>(ctx, "loads", id, "Load");
    const trips = await ctx.store().list<Trip>("trips", { driver_id: member(ctx).driver_id, status: ["ASSIGNED", "DISPATCHED", "COMPLETED"] }, { limit: 200 });
    const trip = trips.find((t) => t.load_ids?.includes(load.id));
    if (!trip) throw new HttpError(404, "Load not found");
    return { load, trip };
  }

  // My open trips (and the last few finished), with each load's stops spelled out.
  r.get("/trips", async (_req, res) => {
    const store = ctx.store();
    const driverId = member(ctx).driver_id!;
    const [open, done] = await Promise.all([
      store.list<Trip>("trips", { driver_id: driverId, status: ["ASSIGNED", "DISPATCHED"] }, { order: "created_at", limit: 50 }),
      store.list<Trip>("trips", { driver_id: driverId, status: "COMPLETED" }, { order: "created_at", limit: 5 }),
    ]);
    const trips = [...open, ...done];
    const loadIds = [...new Set(trips.flatMap((t) => t.load_ids ?? []))];
    const loads = loadIds.length ? await store.list<Load>("loads", { id: loadIds }, { limit: 500 }) : [];
    const locIds = [...new Set(loads.flatMap((l) => [l.pickup_location_id, l.delivery_location_id]).filter((x): x is string => !!x))];
    const locations = locIds.length ? await store.list<Location>("customer_locations", { id: locIds }, { limit: 1000 }) : [];
    const [truck, trailer] = await Promise.all([
      trips[0] ? store.get("trucks", trips[0].truck_id) : null,
      trips[0]?.trailer_id ? store.get("equipment", trips[0].trailer_id) : null,
    ]);
    const loc = new Map(locations.map((l) => [l.id, l]));
    const byId = new Map(loads.map((l) => [l.id, { ...l, pickup: l.pickup_location_id ? loc.get(l.pickup_location_id) ?? null : null, delivery: l.delivery_location_id ? loc.get(l.delivery_location_id) ?? null : null }]));
    res.json({ trips: trips.map((t) => ({ ...t, loads: (t.load_ids ?? []).map((id) => byId.get(id)).filter(Boolean) })), truck, trailer });
  });

  // Accept the trip and head out.
  r.post("/trips/:id/start", async (req, res) => {
    res.json({ trip: await changeTripStatus(ctx, await myTrip(req.params.id), "DISPATCHED") });
  });

  r.post("/trips/:id/complete", async (req, res) => {
    res.json({ trip: await changeTripStatus(ctx, await myTrip(req.params.id), "COMPLETED") });
  });

  // Check in: a check call or stop event, with the phone's position when the driver allows it.
  r.post("/trips/:id/events", async (req, res) => {
    const trip = await myTrip(req.params.id);
    if (trip.status !== "DISPATCHED") throw new HttpError(409, "Start the trip first");
    res.status(201).json({ event: await addTripEvent(ctx, trip, req.body) });
  });

  r.post("/loads/:id/status", async (req, res) => {
    const { status, note } = z.object({ status: z.enum(DRIVER_STATUSES), note: z.string().trim().max(500).optional() }).parse(req.body);
    const { load, trip } = await myLoad(req.params.id);
    if (trip.status !== "DISPATCHED") throw new HttpError(409, trip.status === "ASSIGNED" ? "Start the trip first" : "This trip is finished");
    if (FINISHED.includes(load.status)) throw new HttpError(409, "This load is already delivered");
    res.json({ load: await moveLoad(ctx, load, status, note ?? "Driver update") });
  });

  r.get("/loads/:id/documents", async (req, res) => {
    const { load } = await myLoad(req.params.id);
    res.json({ documents: await listDocuments(ctx, load) });
  });
  r.post("/loads/:id/documents/upload-url", async (req, res) => {
    const { load } = await myLoad(req.params.id);
    res.json(await uploadUrl(ctx, load, req.body));
  });
  r.post("/loads/:id/documents", async (req, res) => {
    const { load } = await myLoad(req.params.id);
    res.status(201).json(await recordDocument(ctx, load, req.body));
  });

  return r;
}
