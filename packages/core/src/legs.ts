// A container move is a chain of legs, each one a drive from one place to
// another with the box either loaded or empty:
//
//   import, live unload   terminal → customer (wait while unloaded) → empty back
//   import, drop          terminal → customer (drop on chassis); later empty → back
//   import, prepull       terminal → our yard; yard → customer; empty → back
//   export, live load     empty pickup → shipper (wait while loaded) → terminal
//   export, drop          empty pickup → shipper (drop); later loaded → terminal
//   one way               pickup → delivery (dry van, flatbed, box truck, cargo van)
//
// Dispatch assigns legs to trips, drivers tap through each leg, and the
// load's status follows its legs.

import type { LoadStatus } from "./status.js";

export const MOVE_TYPES = ["IMPORT_LIVE", "IMPORT_DROP", "IMPORT_PREPULL", "EXPORT_LIVE", "EXPORT_DROP", "ONE_WAY"] as const;
export type MoveType = (typeof MOVE_TYPES)[number];
export const MOVE_LABELS: Record<MoveType, string> = {
  IMPORT_LIVE: "Import · live unload",
  IMPORT_DROP: "Import · drop & pick",
  IMPORT_PREPULL: "Import · prepull to yard",
  EXPORT_LIVE: "Export · live load",
  EXPORT_DROP: "Export · drop & pick",
  ONE_WAY: "Pickup → delivery",
};

export const LEG_STATUSES = ["PLANNED", "ASSIGNED", "DISPATCHED", "AT_ORIGIN", "IN_TRANSIT", "AT_DESTINATION", "DONE", "CANCELED"] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

/** What the driver taps next on a leg; null when there is nothing to tap. */
export const LEG_NEXT: Partial<Record<LegStatus, LegStatus>> = {
  DISPATCHED: "AT_ORIGIN",
  AT_ORIGIN: "IN_TRANSIT",
  IN_TRANSIT: "AT_DESTINATION",
  AT_DESTINATION: "DONE",
};
export const LEG_STARTED: readonly LegStatus[] = ["AT_ORIGIN", "IN_TRANSIT", "AT_DESTINATION", "DONE"];

/** A place a leg starts or ends: a port terminal, or a location (customer site, our yard, an empty depot). */
export type Stop = { terminal_id?: string | null; location_id?: string | null };
export type LegDraft = {
  seq: number;
  cargo: "LOADED" | "EMPTY";
  from_terminal_id: string | null;
  from_location_id: string | null;
  to_terminal_id: string | null;
  to_location_id: string | null;
  /** Live: the truck waits while the customer loads or unloads. Drop: the container is left on its chassis. */
  live: boolean;
};

export type MovePlan = {
  move_type: MoveType;
  terminal_id?: string | null;
  pickup_location_id?: string | null;
  delivery_location_id?: string | null;
  yard_location_id?: string | null;
  return_terminal_id?: string | null;
  return_location_id?: string | null;
  empty_pickup_terminal_id?: string | null;
  empty_pickup_location_id?: string | null;
};

const has = (s: Stop) => Boolean(s.terminal_id || s.location_id);
const leg = (seq: number, cargo: LegDraft["cargo"], from: Stop, to: Stop, live: boolean): LegDraft => ({
  seq, cargo, live,
  from_terminal_id: from.terminal_id ?? null, from_location_id: from.terminal_id ? null : from.location_id ?? null,
  to_terminal_id: to.terminal_id ?? null, to_location_id: to.terminal_id ? null : to.location_id ?? null,
});

/** What is missing to plan this move, in words a dispatcher understands. */
export function planProblems(p: MovePlan): string[] {
  const missing: string[] = [];
  const terminal = { terminal_id: p.terminal_id };
  if (p.move_type === "ONE_WAY") {
    if (!p.pickup_location_id) missing.push("pickup location");
    if (!p.delivery_location_id) missing.push("delivery location");
  } else if (p.move_type.startsWith("IMPORT")) {
    if (!has(terminal)) missing.push("terminal");
    if (!p.delivery_location_id) missing.push("delivery location (consignee)");
    if (p.move_type === "IMPORT_PREPULL" && !p.yard_location_id) missing.push("yard");
  } else {
    if (!has(terminal)) missing.push("terminal (where the loaded box goes)");
    if (!p.pickup_location_id) missing.push("shipper location");
  }
  return missing.length ? [`To plan the move, add: ${missing.join(", ")}`] : [];
}

/** The legs for a move. Empties return to the given terminal or depot, else to the load's terminal; export empties come from the given place, else the terminal. */
export function planLegs(p: MovePlan): LegDraft[] {
  if (planProblems(p).length) return [];
  const terminal: Stop = { terminal_id: p.terminal_id };
  const customerIn: Stop = { location_id: p.delivery_location_id };
  const customerOut: Stop = { location_id: p.pickup_location_id };
  const yard: Stop = { location_id: p.yard_location_id };
  const emptyBack: Stop = p.return_terminal_id || p.return_location_id ? { terminal_id: p.return_terminal_id, location_id: p.return_location_id } : terminal;
  const emptyFrom: Stop = p.empty_pickup_terminal_id || p.empty_pickup_location_id ? { terminal_id: p.empty_pickup_terminal_id, location_id: p.empty_pickup_location_id } : terminal;
  switch (p.move_type) {
    case "IMPORT_LIVE":
      return [leg(1, "LOADED", terminal, customerIn, true), leg(2, "EMPTY", customerIn, emptyBack, false)];
    case "IMPORT_DROP":
      return [leg(1, "LOADED", terminal, customerIn, false), leg(2, "EMPTY", customerIn, emptyBack, false)];
    case "IMPORT_PREPULL":
      return [leg(1, "LOADED", terminal, yard, false), leg(2, "LOADED", yard, customerIn, true), leg(3, "EMPTY", customerIn, emptyBack, false)];
    case "EXPORT_LIVE":
      return [leg(1, "EMPTY", emptyFrom, customerOut, true), leg(2, "LOADED", customerOut, terminal, false)];
    case "EXPORT_DROP":
      return [leg(1, "EMPTY", emptyFrom, customerOut, false), leg(2, "LOADED", customerOut, terminal, false)];
    case "ONE_WAY":
      return [leg(1, "LOADED", { location_id: p.pickup_location_id }, { location_id: p.delivery_location_id }, true)];
  }
}

export type LegState = { seq: number; cargo: "LOADED" | "EMPTY"; status: LegStatus; from_terminal_id?: string | null; to_terminal_id?: string | null; to_location_id?: string | null };

const RANK: LoadStatus[] = ["BOOKED", "ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED"];
export const statusRank = (s: LoadStatus) => RANK.indexOf(s);
const reached = (l: LegState | undefined, s: LegStatus) => Boolean(l && l.status !== "CANCELED" && LEG_STATUSES.indexOf(l.status) >= LEG_STATUSES.indexOf(s));

/**
 * The load status its legs imply. The freight is "picked up" when the loaded
 * box leaves its origin (import: the terminal; export: the shipper) and
 * "delivered" when it reaches its destination (import: the consignee;
 * export: the terminal). Empty legs before or after only move it to
 * dispatched. Null means the legs say nothing yet.
 */
export function statusFromLegs(moveType: MoveType, legs: LegState[]): LoadStatus | null {
  const live = legs.filter((l) => l.status !== "CANCELED").sort((a, b) => a.seq - b.seq);
  if (!live.length) return null;
  const loaded = live.filter((l) => l.cargo === "LOADED");
  const first = loaded[0];
  const last = loaded[loaded.length - 1];
  if (reached(last, "DONE")) return "DELIVERED";
  if (reached(last, "AT_DESTINATION")) return "AT_DELIVERY";
  if (first && first !== last && reached(first, "DONE")) return "IN_TRANSIT"; // prepulled, waiting at the yard
  if (reached(first, "IN_TRANSIT")) return "PICKED_UP";
  if (reached(first, "AT_ORIGIN")) return "AT_PICKUP";
  if (live.some((l) => reached(l, "DISPATCHED"))) return "DISPATCHED";
  if (live.some((l) => reached(l, "ASSIGNED"))) return "ASSIGNED";
  void moveType;
  return null;
}

/** Driver-facing words for the next tap on a leg. */
export function legActionLabel(cargo: "LOADED" | "EMPTY", live: boolean, next: LegStatus, toTerminal: boolean): string {
  switch (next) {
    case "AT_ORIGIN":
      return "Arrived at pickup";
    case "IN_TRANSIT":
      return cargo === "LOADED" ? "Picked up · leaving" : "Hooked empty · leaving";
    case "AT_DESTINATION":
      return "Arrived";
    case "DONE":
      if (cargo === "EMPTY") return toTerminal ? "Empty returned" : live ? "Loaded · done" : "Empty dropped";
      return toTerminal ? "In-gated at terminal" : live ? "Unloaded · done" : "Dropped";
    default:
      return next;
  }
}
