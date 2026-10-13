import { CONTAINER_ONLY_FIELDS, type EquipmentType } from "./equipment.js";
import { containerNumberProblem } from "./container.js";
import { planProblems, type MovePlan, type MoveType } from "./legs.js";

export const LOAD_STATUSES = [
  "DRAFT", "QUOTED", "BOOKED", "PLANNED", "ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT",
  "AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED", "SETTLED", "CLOSED", "CANCELED", "ON_HOLD",
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

/** The moves a load may make from each status. CLOSED and CANCELED are final. */
export const LOAD_TRANSITIONS: Record<LoadStatus, readonly LoadStatus[]> = {
  DRAFT: ["QUOTED", "BOOKED", "CANCELED"],
  QUOTED: ["BOOKED", "DRAFT", "CANCELED"],
  BOOKED: ["PLANNED", "ASSIGNED", "ON_HOLD", "CANCELED"],
  PLANNED: ["ASSIGNED", "BOOKED", "ON_HOLD", "CANCELED"],
  ASSIGNED: ["DISPATCHED", "BOOKED", "ON_HOLD", "CANCELED"],
  DISPATCHED: ["AT_PICKUP", "ASSIGNED", "ON_HOLD"],
  AT_PICKUP: ["PICKED_UP", "ON_HOLD"],
  PICKED_UP: ["IN_TRANSIT", "AT_DELIVERY", "ON_HOLD"],
  IN_TRANSIT: ["AT_DELIVERY", "ON_HOLD"],
  AT_DELIVERY: ["DELIVERED", "ON_HOLD"],
  DELIVERED: ["POD_RECEIVED", "INVOICED"],
  POD_RECEIVED: ["INVOICED"],
  INVOICED: ["SETTLED"],
  SETTLED: ["CLOSED"],
  CLOSED: [],
  CANCELED: [],
  ON_HOLD: ["BOOKED", "ASSIGNED", "DISPATCHED", "PICKED_UP", "IN_TRANSIT", "CANCELED"],
};

/** Statuses where the load is still waiting for a truck. */
export const DISPATCHABLE: readonly LoadStatus[] = ["BOOKED", "PLANNED"];
/** Statuses where the work is done and the load can be billed. */
export const BILLABLE: readonly LoadStatus[] = ["DELIVERED", "POD_RECEIVED"];
/** Statuses where nothing more happens on the road. */
export const FINISHED: readonly LoadStatus[] = ["DELIVERED", "POD_RECEIVED", "INVOICED", "SETTLED", "CLOSED", "CANCELED"];

export function canTransition(from: LoadStatus, to: LoadStatus): boolean {
  return LOAD_TRANSITIONS[from].includes(to);
}

export type LoadFields = {
  equipment_type: EquipmentType;
  customer_id?: string | null;
  pickup_location_id?: string | null;
  delivery_location_id?: string | null;
  rate?: number | null;
  commodity?: string | null;
  weight_lbs?: number | null;
  direction?: string | null;
  container_number?: string | null;
  container_size?: string | null;
  booking_number?: string | null;
  is_street_turn?: boolean | null;
  move_type?: MoveType | null;
} & Omit<MovePlan, "move_type"> & Partial<Record<(typeof CONTAINER_ONLY_FIELDS)[number], unknown>>;

/** The move a load makes when none was chosen: live for containers, straight through for other freight. */
export function moveTypeOf(load: { equipment_type: EquipmentType; direction?: string | null; move_type?: MoveType | null }): MoveType {
  if (load.move_type) return load.move_type;
  if (load.equipment_type !== "CONTAINER") return "ONE_WAY";
  return load.direction === "EXPORT" ? "EXPORT_LIVE" : "IMPORT_LIVE";
}

/** Shape problems that make a load wrong at any status. */
export function loadShapeProblems(load: LoadFields): string[] {
  const problems: string[] = [];
  if (load.equipment_type !== "CONTAINER") {
    const stray = CONTAINER_ONLY_FIELDS.filter((f) => load[f] !== undefined && load[f] !== null && load[f] !== "");
    if (stray.length) problems.push(`${stray.join(", ")} only apply to container loads`);
    if (load.is_street_turn) problems.push("Only container loads can be street turns");
  }
  if (load.container_number) {
    const p = containerNumberProblem(load.container_number);
    if (p) problems.push(p);
  }
  if (load.move_type) {
    const mt = load.move_type;
    if (load.equipment_type !== "CONTAINER" && mt !== "ONE_WAY") problems.push("Only containers make import or export moves");
    if (load.equipment_type === "CONTAINER" && mt === "ONE_WAY") problems.push("A container move is an import or an export");
    if (load.direction === "IMPORT" && mt.startsWith("EXPORT")) problems.push("An import cannot make an export move");
    if (load.direction === "EXPORT" && mt.startsWith("IMPORT")) problems.push("An export cannot make an import move");
  }
  return problems;
}

/** What is still missing before a load can be booked. */
export function bookingProblems(load: LoadFields): string[] {
  const missing: string[] = [];
  if (!load.customer_id) missing.push("customer");
  if (load.rate == null) missing.push("rate");
  if (load.equipment_type === "CONTAINER") {
    if (!load.direction) missing.push("import or export");
    if (!load.container_size) missing.push("container size");
    if (load.direction === "IMPORT" && !load.container_number) missing.push("container number");
    if (load.direction === "EXPORT" && !load.booking_number) missing.push("booking number");
  } else {
    if (!load.commodity) missing.push("commodity");
    if (!load.weight_lbs) missing.push("weight");
  }
  const plan = load.equipment_type === "CONTAINER" && !load.direction ? [] : planProblems({ ...load, move_type: moveTypeOf(load) });
  return [...loadShapeProblems(load), ...(missing.length ? [`Missing ${missing.join(", ")}`] : []), ...plan];
}
