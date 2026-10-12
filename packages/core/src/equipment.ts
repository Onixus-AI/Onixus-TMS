// What kind of freight a load is, and what it takes to move it. Drayage
// (containers) is the main business; flatbed, dry van, box truck and cargo
// van loads run through the same loads and dispatch flow.

export const EQUIPMENT_TYPES = ["CONTAINER", "FLATBED", "DRY_VAN", "BOX_TRUCK", "CARGO_VAN"] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const EQUIPMENT_LABELS: Record<EquipmentType, string> = {
  CONTAINER: "Container (drayage)",
  FLATBED: "Flatbed",
  DRY_VAN: "Dry van",
  BOX_TRUCK: "Box truck",
  CARGO_VAN: "Cargo van",
};

/** Power units. A tractor pulls a chassis, flatbed or dry van; box trucks and cargo vans carry the freight themselves. */
export const TRUCK_KINDS = ["TRACTOR", "BOX_TRUCK", "CARGO_VAN"] as const;
export type TruckKind = (typeof TRUCK_KINDS)[number];

export const TRAILER_KINDS = ["CHASSIS", "FLATBED", "DRY_VAN"] as const;
export type TrailerKind = (typeof TRAILER_KINDS)[number];

export const CONTAINER_SIZES = ["20", "40", "45"] as const;
export const CONTAINER_TYPES = ["GP", "HC", "REEFER", "OPEN_TOP", "FLAT_RACK", "TANK"] as const;
export const DIRECTIONS = ["IMPORT", "EXPORT"] as const;

type Rule = { trucks: readonly TruckKind[]; trailer: TrailerKind | null; trailerRequired: boolean };

export const EQUIPMENT_RULES: Record<EquipmentType, Rule> = {
  // A container rides on a chassis, often a pool chassis picked up at the
  // terminal, so the chassis does not have to be assigned at dispatch.
  CONTAINER: { trucks: ["TRACTOR"], trailer: "CHASSIS", trailerRequired: false },
  FLATBED: { trucks: ["TRACTOR"], trailer: "FLATBED", trailerRequired: true },
  DRY_VAN: { trucks: ["TRACTOR"], trailer: "DRY_VAN", trailerRequired: true },
  BOX_TRUCK: { trucks: ["BOX_TRUCK"], trailer: null, trailerRequired: false },
  // A box truck can take a cargo van load; never the other way round.
  CARGO_VAN: { trucks: ["CARGO_VAN", "BOX_TRUCK"], trailer: null, trailerRequired: false },
};

/** Fields that only make sense on a container load. */
export const CONTAINER_ONLY_FIELDS = [
  "container_number",
  "container_size",
  "container_type",
  "chassis_number",
  "direction",
  "last_free_day",
  "cutoff_at",
] as const;

export type LoadLike = {
  equipment_type: EquipmentType;
  container_size?: string | null;
  weight_lbs?: number | null;
  hazmat?: boolean | null;
};
export type TruckLike = { kind: TruckKind; status?: string | null; gvwr_lbs?: number | null; max_payload_lbs?: number | null };
export type TrailerLike = { kind: TrailerKind; status?: string | null; size?: string | null; max_payload_lbs?: number | null };
export type DriverLike = {
  status?: string | null;
  cdl_class?: string | null;
  license_expiry?: string | null;
  medical_card_expiry?: string | null;
  twic_expiry?: string | null;
  hazmat_endorsement?: boolean | null;
};

/** Over this gross weight a straight truck needs a commercial licence (class B). */
export const CDL_GVWR_LBS = 26_000;

const expired = (date: string | null | undefined, today: string) => !date || date < today;

/** Which CDL class the truck needs: A for a tractor-trailer, B for a heavy straight truck, none otherwise. */
export function cdlRequired(truck: TruckLike): "A" | "B" | null {
  if (truck.kind === "TRACTOR") return "A";
  if (truck.kind === "BOX_TRUCK" && (truck.gvwr_lbs ?? 0) > CDL_GVWR_LBS) return "B";
  return null;
}

/** Does a chassis size like "40", "20/40" or "40/45" take this container size? */
export function chassisFits(chassisSize: string | null | undefined, containerSize: string | null | undefined): boolean {
  if (!chassisSize || !containerSize) return true;
  return chassisSize.split("/").map((s) => s.trim()).includes(containerSize);
}

/**
 * Everything wrong with putting these loads on this driver, truck and trailer.
 * Empty means the trip can be dispatched. `today` is an ISO date (YYYY-MM-DD).
 */
export function dispatchProblems(input: {
  loads: LoadLike[];
  truck: TruckLike;
  trailer?: TrailerLike | null;
  driver: DriverLike;
  today: string;
}): string[] {
  const { loads, truck, trailer, driver, today } = input;
  const problems: string[] = [];
  if (!loads.length) return ["Pick at least one load"];

  const kinds = new Set(loads.map((l) => l.equipment_type));
  if (kinds.size > 1) problems.push("A trip carries one kind of freight; these loads need different equipment");
  const type = loads[0].equipment_type;
  const rule = EQUIPMENT_RULES[type];
  const label = EQUIPMENT_LABELS[type];

  // Dual transaction: drop one container and pick up another in the same trip.
  if (type === "CONTAINER" && loads.length > 2) problems.push("A container trip carries at most two loads (one dual transaction)");

  if (!rule.trucks.includes(truck.kind)) problems.push(`A ${label} load needs a ${rule.trucks.join(" or ").toLowerCase().replace(/_/g, " ")}, not a ${truck.kind.toLowerCase().replace(/_/g, " ")}`);
  if (truck.status && truck.status !== "AVAILABLE") problems.push(`Truck is ${truck.status.toLowerCase()}`);

  if (trailer) {
    if (!rule.trailer) problems.push(`A ${label} load does not take a trailer`);
    else if (trailer.kind !== rule.trailer) problems.push(`A ${label} load needs a ${rule.trailer.toLowerCase().replace(/_/g, " ")}, not a ${trailer.kind.toLowerCase().replace(/_/g, " ")}`);
    if (trailer.status && trailer.status !== "AVAILABLE") problems.push(`Trailer is ${trailer.status.toLowerCase()}`);
    if (trailer.kind === "CHASSIS") {
      for (const l of loads) if (!chassisFits(trailer.size, l.container_size)) problems.push(`A ${trailer.size}' chassis does not take a ${l.container_size}' container`);
    }
  } else if (rule.trailerRequired) {
    problems.push(`A ${label} load needs a ${rule.trailer!.toLowerCase().replace(/_/g, " ")} trailer`);
  }

  const weight = loads.reduce((sum, l) => sum + (l.weight_lbs ?? 0), 0);
  const capacity = trailer?.max_payload_lbs ?? (rule.trailer ? null : truck.max_payload_lbs);
  if (capacity && weight > capacity) problems.push(`${weight.toLocaleString("en-US")} lbs is over the ${capacity.toLocaleString("en-US")} lbs payload`);

  if (driver.status && driver.status !== "AVAILABLE") problems.push(`Driver is ${driver.status.toLowerCase()}`);
  if (expired(driver.license_expiry, today)) problems.push("Driver's licence is missing or expired");
  const cdl = cdlRequired(truck);
  if (cdl) {
    const held = driver.cdl_class ?? "";
    if (!(held === "A" || (cdl === "B" && held === "B"))) problems.push(`This truck needs a class ${cdl} CDL`);
    if (expired(driver.medical_card_expiry, today)) problems.push("Driver's DOT medical card is missing or expired");
  }
  if (loads.some((l) => l.hazmat)) {
    if (!cdl) problems.push("Hazmat freight needs a CDL truck and driver");
    if (!driver.hazmat_endorsement) problems.push("Hazmat freight needs a driver with a hazmat endorsement");
  }
  // Port terminals admit only drivers with a valid TWIC card.
  if (type === "CONTAINER" && expired(driver.twic_expiry, today)) problems.push("Driver's TWIC card is missing or expired; terminals will refuse the truck");
  return problems;
}
