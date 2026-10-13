import { Router } from "express";
import { z } from "zod";
import { LEG_NEXT, LEG_STARTED, LEG_STATUSES, moveTypeOf, planLegs, statusFromLegs, statusRank, type LegDraft, type LegStatus, type MoveType } from "@onixus/core";
import { defined, HttpError, mustGet, text, type Ctx } from "../http.js";
import { syncAppointment } from "./connections.js";
import { moveLoad, type Load } from "./loads.js";

// The legs of a container move (see packages/core/src/legs.ts): planned when
// the load is booked, assigned to trips by dispatch, tapped through by the
// driver. The load's status, out-gate, empty return and in-gate follow them.

export type Leg = LegDraft & {
  id: string;
  load_id: string;
  status: LegStatus;
  trip_id: string | null;
  appointment_at?: string | null;
  appointment_number?: string | null;
  started_at?: string | null;
  arrived_at?: string | null;
  done_at?: string | null;
};

export const legsOf = (ctx: Ctx, loadId: string) => ctx.store().list<Leg>("load_legs", { load_id: loadId }, { order: "seq", ascending: true, limit: 50 });
const active = (legs: Leg[]) => legs.filter((l) => l.status !== "CANCELED");
const sameRoute = (a: LegDraft, b: LegDraft) =>
  a.cargo === b.cargo && a.live === b.live && a.from_terminal_id === b.from_terminal_id && a.from_location_id === b.from_location_id && a.to_terminal_id === b.to_terminal_id && a.to_location_id === b.to_location_id;

/**
 * (Re)plan a load's legs from its move. Nothing changes once any leg is
 * assigned; until then a changed plan cancels the old legs and adds new
 * ones, and an unchanged plan is left alone.
 */
export async function planLoadLegs(ctx: Ctx, load: Load): Promise<Leg[]> {
  const existing = await legsOf(ctx, load.id);
  const current = active(existing);
  if (current.some((l) => l.status !== "PLANNED")) return current;
  const drafts = planLegs({ ...load, move_type: moveTypeOf(load) });
  if (!drafts.length) return current;
  if (current.length === drafts.length && current.every((l, i) => sameRoute(l, drafts[i]))) return current;
  const store = ctx.store();
  for (const l of current) await store.update("load_legs", l.id, { status: "CANCELED" }, { status: "PLANNED" });
  const offset = existing.reduce((m, l) => Math.max(m, l.seq), 0);
  const created: Leg[] = [];
  for (const d of drafts) created.push(await store.insert<Leg>("load_legs", { ...d, seq: d.seq + offset, load_id: load.id, status: "PLANNED", trip_id: null }));
  if (load.move_type !== moveTypeOf(load)) await store.update("loads", load.id, { move_type: moveTypeOf(load) });
  return created;
}

const HOLD_OR_DONE = new Set(["ON_HOLD", "CANCELED", "POD_RECEIVED", "INVOICED", "SETTLED", "CLOSED", "DRAFT", "QUOTED"]);

/** Move the load forward to what its legs say; never backwards, never out of hold or billing. */
export async function syncLoad(ctx: Ctx, loadId: string): Promise<Load> {
  const load = await mustGet<Load>(ctx, "loads", loadId, "Load");
  if (HOLD_OR_DONE.has(load.status)) return load;
  const target = statusFromLegs(moveTypeOf(load) as MoveType, await legsOf(ctx, load.id));
  if (!target || statusRank(target) <= statusRank(load.status)) return load;
  return moveLoad(ctx, load, target, "From the legs", { system: true });
}

/**
 * The next step on a leg (arrived, picked up, arrived, done), with the
 * container clocks that step sets: the loaded import (or the export's
 * empty) leaving the terminal starts per diem; the empty back at the
 * terminal or depot, or the loaded export in-gating, stops it.
 */
export async function advanceLeg(ctx: Ctx, leg: Leg, to?: LegStatus): Promise<{ leg: Leg; load: Load }> {
  const next = LEG_NEXT[leg.status];
  if (!next) throw new HttpError(409, leg.status === "PLANNED" || leg.status === "ASSIGNED" ? "Dispatch this leg's trip first" : "This leg is finished");
  if (to && to !== next) throw new HttpError(409, `This leg is ${leg.status.toLowerCase().replace(/_/g, " ")}; the next step is ${next.toLowerCase().replace(/_/g, " ")}`);
  if (next === "AT_ORIGIN") {
    // A container's legs run in order: no heading back empty before the box is delivered.
    const earlier = (await legsOf(ctx, leg.load_id)).filter((l) => l.seq < leg.seq && l.status !== "CANCELED" && l.status !== "DONE");
    if (earlier.length) throw new HttpError(409, `Finish leg ${earlier.map((l) => l.seq).join(", ")} of this load first`);
  }
  const now = ctx.now().toISOString();
  const stamp = next === "AT_ORIGIN" ? { started_at: now } : next === "AT_DESTINATION" ? { arrived_at: now } : next === "DONE" ? { done_at: now } : {};
  const updated = await ctx.store().update<Leg>("load_legs", leg.id, { status: next, ...stamp }, { status: leg.status });
  if (!updated) throw new HttpError(409, "This leg changed while you were working; reload and try again");

  const load = await mustGet<Load>(ctx, "loads", leg.load_id, "Load");
  const patch: Record<string, unknown> = {};
  const leavingTerminalLoaded = next === "IN_TRANSIT" && leg.cargo === "LOADED" && leg.from_terminal_id && load.direction === "IMPORT";
  const exportEmptyLeaving = next === "IN_TRANSIT" && leg.cargo === "EMPTY" && load.direction === "EXPORT";
  if ((leavingTerminalLoaded || exportEmptyLeaving) && !load.outgated_at) patch.outgated_at = now;
  if (next === "DONE" && leg.cargo === "EMPTY" && load.direction === "IMPORT" && !load.empty_returned_at) patch.empty_returned_at = now;
  if (next === "DONE" && leg.cargo === "LOADED" && leg.to_terminal_id && load.direction === "EXPORT" && !load.ingated_at) patch.ingated_at = now;
  if (Object.keys(patch).length) await ctx.store().update("loads", load.id, { ...patch, updated_at: now });
  return { leg: updated, load: await syncLoad(ctx, load.id) };
}

export const legStarted = (l: Leg) => LEG_STARTED.includes(l.status);

/** Names (and addresses) for every terminal and location these legs touch, keyed by id. */
export async function placesFor(ctx: Ctx, legs: Leg[]) {
  const store = ctx.store();
  const locIds = [...new Set(legs.flatMap((l) => [l.from_location_id, l.to_location_id]).filter((x): x is string => !!x))];
  const termIds = [...new Set(legs.flatMap((l) => [l.from_terminal_id, l.to_terminal_id]).filter((x): x is string => !!x))];
  const [locations, terminals] = await Promise.all([
    locIds.length ? store.list<Record<string, unknown> & { id: string }>("customer_locations", { id: locIds }, { limit: 1000 }) : [],
    termIds.length ? store.list<Record<string, unknown> & { id: string }>("port_terminals", { id: termIds }, { limit: 500 }) : [],
  ]);
  return Object.fromEntries([
    ...locations.map((l) => [l.id, { ...l, kind: (l.kind as string) ?? "CUSTOMER" }]),
    ...terminals.map((t) => [t.id, { ...t, label: t.name, kind: "TERMINAL" }]),
  ]);
}

const appointment = z.object({ appointment_at: z.string().datetime({ offset: true }).nullable().optional(), appointment_number: text(60).nullable().optional() });

export function legRoutes(ctx: Ctx) {
  const r = Router();

  // Legs waiting for a truck (or in any given status), with their load and named places, for the dispatch board.
  r.get("/legs", async (req, res) => {
    const { status } = z.object({ status: z.string().default("PLANNED") }).parse(req.query);
    const statuses = z.array(z.enum(LEG_STATUSES)).parse(status.split(","));
    const store = ctx.store();
    const legs = await store.list<Leg>("load_legs", { status: statuses }, { order: "created_at", ascending: true, limit: 500 });
    const loadIds = [...new Set(legs.map((l) => l.load_id))];
    const loads = loadIds.length ? await store.list<Load>("loads", { id: loadIds }, { limit: 500 }) : [];
    const live = new Set(loads.filter((l) => !["CANCELED", "ON_HOLD", "CLOSED", "DRAFT", "QUOTED"].includes(l.status)).map((l) => l.id));
    const shown = legs.filter((l) => live.has(l.load_id));
    res.json({ legs: shown, loads: loads.filter((l) => live.has(l.id)), places: await placesFor(ctx, shown) });
  });

  r.post("/loads/:id/legs/plan", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    res.json({ legs: await planLoadLegs(ctx, load) });
  });

  // The office can tap a leg forward too (a driver without the app, a correction).
  r.post("/legs/:id/advance", async (req, res) => {
    const { to } = z.object({ to: z.string().optional() }).parse(req.body ?? {});
    const leg = await mustGet<Leg>(ctx, "load_legs", req.params.id, "Leg");
    res.json(await advanceLeg(ctx, leg, to as LegStatus | undefined));
  });

  // Terminal appointment for this leg's pickup or return.
  r.patch("/legs/:id", async (req, res) => {
    const leg = await mustGet<Leg>(ctx, "load_legs", req.params.id, "Leg");
    const patch = defined(appointment.parse(req.body));
    const updated = await ctx.store().update<Leg>("load_legs", leg.id, patch);
    // On the company's calendar too, when it connected one.
    if ("appointment_at" in patch && updated) {
      const load = await ctx.store().get<Load>("loads", leg.load_id);
      const places = await placesFor(ctx, [updated]);
      const name = (t?: string | null, l?: string | null) => (places[t ?? l ?? ""] as { label?: string } | undefined)?.label ?? "";
      const from = name(updated.from_terminal_id, updated.from_location_id), to = name(updated.to_terminal_id, updated.to_location_id);
      const ref = load?.container_number ?? load?.load_number ?? "Load";
      syncAppointment(ctx, `leg:${updated.id}`, updated.appointment_at
        ? { title: `${ref} · ${from || "pickup"} → ${to || "delivery"}`, description: [updated.appointment_number ? `Appointment #${updated.appointment_number}` : "", `Leg ${updated.seq} (${String(updated.cargo ?? "").toLowerCase()})`, "From Onixus Logistics OS"].filter(Boolean).join("\n"), start: updated.appointment_at, minutes: 60, location: from || undefined }
        : null);
    }
    res.json({ leg: updated });
  });

  return r;
}
