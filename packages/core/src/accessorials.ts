// Drayage extras: the charges on top of the line haul that a container move
// earns and that drayage companies most often forget to bill. Each one is
// computed from what already happened on the load (its clocks and its legs),
// priced from the company's rate card, and suggested on the invoice, where
// the dispatcher can change or drop it.

export type RateCard = {
  /** Pool chassis, per calendar day from out-gate to empty return / in-gate. */
  chassis_per_day: number;
  /** Flat fee when the container is pulled to our yard before delivery. */
  prepull: number;
  /** Per day the container sits in our yard after the free days. */
  yard_storage_per_day: number;
  yard_free_days: number;
  /** Per hour the truck waits at a live load or unload after the free hours. */
  waiting_per_hour: number;
  waiting_free_hours: number;
  /** Flat fee when the cargo weighs more than the threshold (tri-axle chassis, permits). */
  overweight: number;
  overweight_over_lbs: number;
  hazmat: number;
};

export const DEFAULT_RATE_CARD: RateCard = {
  chassis_per_day: 40,
  prepull: 150,
  yard_storage_per_day: 50,
  yard_free_days: 1,
  waiting_per_hour: 85,
  waiting_free_hours: 2,
  overweight: 150,
  overweight_over_lbs: 44_000,
  hazmat: 150,
};

export const ACCESSORIAL_LABELS: Record<string, string> = {
  CHASSIS: "Chassis",
  PREPULL: "Prepull",
  YARD_STORAGE: "Yard storage",
  WAITING: "Waiting time",
  OVERWEIGHT: "Overweight",
  HAZMAT: "Hazmat",
};

export type ChargeLine = { code: string; description: string; quantity: number; rate: number; amount: number };

export type ChargeLoad = {
  equipment_type: string;
  direction?: string | null;
  move_type?: string | null;
  hazmat?: boolean | null;
  weight_lbs?: number | null;
  yard_location_id?: string | null;
  outgated_at?: string | null;
  empty_returned_at?: string | null;
  ingated_at?: string | null;
};
export type ChargeLeg = {
  seq: number;
  status: string;
  live: boolean;
  from_location_id?: string | null;
  to_location_id?: string | null;
  started_at?: string | null;
  arrived_at?: string | null;
  done_at?: string | null;
};

const DAY = 86_400_000;
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
const cents = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Merge a stored (possibly partial or stale) rate card over the defaults, keeping only sane numbers. */
export function rateCard(stored?: Partial<Record<keyof RateCard, unknown>> | null): RateCard {
  const out = { ...DEFAULT_RATE_CARD };
  for (const k of Object.keys(out) as (keyof RateCard)[]) {
    const v = stored?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** The extras this load has earned so far, priced from the rate card. Zero-priced lines are left out. */
export function suggestedCharges(load: ChargeLoad, legs: ChargeLeg[], card: RateCard, now: Date): ChargeLine[] {
  const lines: ChargeLine[] = [];
  const add = (code: string, quantity: number, rate: number, detail: string) => {
    const amount = cents(quantity * rate);
    if (amount > 0) lines.push({ code, description: `${ACCESSORIAL_LABELS[code]}: ${detail}`, quantity, rate, amount });
  };
  const live = legs.filter((l) => l.status !== "CANCELED").sort((a, b) => a.seq - b.seq);

  if (load.equipment_type === "CONTAINER") {
    // Pool chassis bill every calendar day the box is on it, both ends counted.
    if (load.outgated_at) {
      const end = load.empty_returned_at ?? load.ingated_at ?? now.toISOString();
      const days = Math.max(1, dayNumber(end) - dayNumber(load.outgated_at) + 1);
      add("CHASSIS", days, card.chassis_per_day, `${plural(days, "day")} × ${usd(card.chassis_per_day)}`);
    }
    if (load.move_type === "IMPORT_PREPULL" && live.some((l) => l.to_location_id === load.yard_location_id && l.status === "DONE")) {
      add("PREPULL", 1, card.prepull, "pulled to our yard before delivery");
    }
    // Yard storage: from the drop at our yard until the next leg leaves it.
    if (load.yard_location_id) {
      const into = live.find((l) => l.to_location_id === load.yard_location_id && l.done_at);
      if (into) {
        const out = live.find((l) => l.seq > into.seq && l.from_location_id === load.yard_location_id);
        const days = Math.max(0, dayNumber(out?.started_at ?? now.toISOString()) - dayNumber(into.done_at!) - card.yard_free_days);
        add("YARD_STORAGE", days, card.yard_storage_per_day, `${plural(days, "day")} after ${plural(card.yard_free_days, "free day")} × ${usd(card.yard_storage_per_day)}`);
      }
    }
  }

  // Waiting: a live leg's time at the destination, billed by the quarter hour after the free time.
  let waited = 0;
  for (const l of live) {
    if (!l.live || !l.arrived_at || !l.done_at) continue;
    const hours = (Date.parse(l.done_at) - Date.parse(l.arrived_at)) / 3_600_000 - card.waiting_free_hours;
    if (hours > 0) waited += Math.ceil(hours * 4) / 4;
  }
  if (waited > 0) add("WAITING", waited, card.waiting_per_hour, `${waited} h after ${card.waiting_free_hours} free × ${usd(card.waiting_per_hour)}/h`);

  if (load.weight_lbs && load.weight_lbs > card.overweight_over_lbs) {
    add("OVERWEIGHT", 1, card.overweight, `${load.weight_lbs.toLocaleString("en-US")} lbs (over ${card.overweight_over_lbs.toLocaleString("en-US")})`);
  }
  if (load.hazmat) add("HAZMAT", 1, card.hazmat, "hazardous cargo");
  return lines;
}
