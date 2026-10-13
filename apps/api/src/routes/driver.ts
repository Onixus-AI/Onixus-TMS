import { Router } from "express";
import { z } from "zod";
import { LEG_STATUSES } from "@onixus/core";
import { HttpError, member, mustGet, type Ctx } from "../http.js";
import type { Load } from "./loads.js";
import { addTripEvent, changeTripStatus, type Trip } from "./fleet.js";
import { advanceLeg, type Leg } from "./legs.js";
import { listDocuments, recordDocument, uploadUrl } from "./documents.js";

// The driver app. A driver sees only trips assigned to their driver record
// and works them leg by leg (arrived, picked up, arrived, dropped or
// unloaded); the loads' statuses and container clocks follow.

type Place = { id: string; name?: string; label?: string; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; lat?: number | null; lng?: number | null };

export function driverRoutes(ctx: Ctx) {
  const r = Router();

  async function myTrip(id: string): Promise<Trip> {
    const trip = await mustGet<Trip>(ctx, "trips", id, "Trip");
    if (trip.driver_id !== member(ctx).driver_id) throw new HttpError(404, "Trip not found");
    return trip;
  }

  /** A leg on one of my trips. */
  async function myLeg(id: string): Promise<{ leg: Leg; trip: Trip }> {
    const leg = await mustGet<Leg>(ctx, "load_legs", id, "Leg");
    const trip = leg.trip_id ? await ctx.store().get<Trip & { id: string }>("trips", leg.trip_id) : null;
    if (!trip || trip.driver_id !== member(ctx).driver_id) throw new HttpError(404, "Leg not found");
    return { leg, trip };
  }

  /** A load on one of my trips. */
  async function myLoad(id: string): Promise<{ load: Load; trip: Trip }> {
    const load = await mustGet<Load>(ctx, "loads", id, "Load");
    const trips = await ctx.store().list<Trip>("trips", { driver_id: member(ctx).driver_id, status: ["ASSIGNED", "DISPATCHED", "COMPLETED"] }, { limit: 200 });
    const trip = trips.find((t) => t.load_ids?.includes(load.id));
    if (!trip) throw new HttpError(404, "Load not found");
    return { load, trip };
  }

  // My open trips (and the last few finished): each leg in order, with its places and load spelled out.
  r.get("/trips", async (_req, res) => {
    const store = ctx.store();
    const driverId = member(ctx).driver_id!;
    const [open, done] = await Promise.all([
      store.list<Trip>("trips", { driver_id: driverId, status: ["ASSIGNED", "DISPATCHED"] }, { order: "created_at", limit: 50 }),
      store.list<Trip>("trips", { driver_id: driverId, status: "COMPLETED" }, { order: "created_at", limit: 5 }),
    ]);
    const trips = [...open, ...done];
    const legIds = [...new Set(trips.flatMap((t) => t.leg_ids ?? []))];
    const legs = legIds.length ? await store.list<Leg>("load_legs", { id: legIds }, { limit: 500 }) : [];
    const loadIds = [...new Set([...trips.flatMap((t) => t.load_ids ?? []), ...legs.map((l) => l.load_id)])];
    const loads = loadIds.length ? await store.list<Load>("loads", { id: loadIds }, { limit: 500 }) : [];
    const locIds = [...new Set(legs.flatMap((l) => [l.from_location_id, l.to_location_id]).filter((x): x is string => !!x))];
    const termIds = [...new Set(legs.flatMap((l) => [l.from_terminal_id, l.to_terminal_id]).filter((x): x is string => !!x))];
    const [locations, terminals] = await Promise.all([
      locIds.length ? store.list<Place>("customer_locations", { id: locIds }, { limit: 1000 }) : [],
      termIds.length ? store.list<Place>("port_terminals", { id: termIds }, { limit: 500 }) : [],
    ]);
    const [truck, trailer] = await Promise.all([
      trips[0] ? store.get("trucks", trips[0].truck_id) : null,
      trips[0]?.trailer_id ? store.get("equipment", trips[0].trailer_id) : null,
    ]);
    const place = new Map<string, Place & { kind: string }>([
      ...locations.map((l) => [l.id, { ...l, kind: "LOCATION" }] as const),
      ...terminals.map((t) => [t.id, { ...t, label: t.name, kind: "TERMINAL" }] as const),
    ]);
    const loadById = new Map(loads.map((l) => [l.id, l]));
    const legById = new Map(legs.map((l) => [l.id, {
      ...l,
      from: place.get(l.from_terminal_id ?? l.from_location_id ?? "") ?? null,
      to: place.get(l.to_terminal_id ?? l.to_location_id ?? "") ?? null,
      load: loadById.get(l.load_id) ?? null,
    }]));
    res.json({
      trips: trips.map((t) => ({ ...t, legs: (t.leg_ids ?? []).map((id) => legById.get(id)).filter(Boolean), loads: (t.load_ids ?? []).map((id) => loadById.get(id)).filter(Boolean) })),
      truck, trailer,
    });
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

  // The next step on a leg: arrived, picked up / hooked, arrived, dropped / unloaded / returned.
  r.post("/legs/:id/advance", async (req, res) => {
    const { to } = z.object({ to: z.enum(LEG_STATUSES).optional() }).parse(req.body ?? {});
    const { leg, trip } = await myLeg(req.params.id);
    if (trip.status !== "DISPATCHED") throw new HttpError(409, trip.status === "ASSIGNED" ? "Start the trip first" : "This trip is finished");
    res.json(await advanceLeg(ctx, leg, to));
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
