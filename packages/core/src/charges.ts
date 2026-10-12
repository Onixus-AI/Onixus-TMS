// Container clocks. Two charges run on every import container:
//  - demurrage: the terminal bills each day after the last free day (LFD)
//    until the container leaves the terminal (out-gate);
//  - per diem: the steamship line bills each day after its free days until
//    the empty is returned.
// Missing either clock is the most expensive mistake in drayage, so these
// numbers drive the alerts board.

/** Defaults for a new container load (the database uses the same ones); override per load. */
export const CONTAINER_DEFAULTS = { demurrage_per_day: 275, per_diem_per_day: 150, per_diem_free_days: 4 } as const;

const DAY = 86_400_000;
/** Whole days since 1970 for an ISO date or timestamp, using its UTC date. */
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);

export type ContainerClock = {
  equipment_type: string;
  direction?: string | null;
  status?: string | null;
  last_free_day?: string | null;
  outgated_at?: string | null;
  empty_returned_at?: string | null;
  cutoff_at?: string | null;
  demurrage_per_day?: number | null;
  per_diem_per_day?: number | null;
  per_diem_free_days?: number | null;
};

export function demurrage(load: ContainerClock, now: Date): { days: number; amount: number } {
  if (load.equipment_type !== "CONTAINER" || !load.last_free_day) return { days: 0, amount: 0 };
  const end = load.outgated_at ?? now.toISOString();
  const days = Math.max(0, dayNumber(end) - dayNumber(load.last_free_day));
  return { days, amount: days * (load.demurrage_per_day ?? 0) };
}

export function perDiem(load: ContainerClock, now: Date): { days: number; amount: number; freeDaysLeft: number } {
  if (load.equipment_type !== "CONTAINER" || !load.outgated_at) return { days: 0, amount: 0, freeDaysLeft: 0 };
  const free = load.per_diem_free_days ?? 4;
  const used = dayNumber(load.empty_returned_at ?? now.toISOString()) - dayNumber(load.outgated_at);
  const days = Math.max(0, used - free);
  return { days, amount: days * (load.per_diem_per_day ?? 0), freeDaysLeft: Math.max(0, free - used) };
}

export const RISK_LEVELS = ["NONE", "WATCH", "URGENT", "ACCRUING"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ContainerRisk = { level: RiskLevel; reason: string; demurrage: number; perDiem: number };

const DONE = new Set(["CANCELED", "CLOSED", "SETTLED"]);
const AT_TERMINAL_OR_LATER = new Set(["AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED", "SETTLED", "CLOSED"]);

/** How worried dispatch should be about this container right now. */
export function containerRisk(load: ContainerClock, now: Date): ContainerRisk {
  const d = demurrage(load, now);
  const p = perDiem(load, now);
  const base = { demurrage: d.amount, perDiem: p.amount };
  if (load.equipment_type !== "CONTAINER" || DONE.has(load.status ?? "")) return { level: "NONE", reason: "", ...base };

  if (!load.outgated_at && load.last_free_day) {
    const left = dayNumber(load.last_free_day) - dayNumber(now.toISOString());
    if (left < 0) return { level: "ACCRUING", reason: `Demurrage: ${d.days} day(s) past the last free day`, ...base };
    if (left <= 1) return { level: "URGENT", reason: left === 0 ? "Last free day is today" : "Last free day is tomorrow", ...base };
    if (left === 2) return { level: "WATCH", reason: "Last free day in 2 days", ...base };
  }
  if (load.outgated_at && !load.empty_returned_at) {
    if (p.days > 0) return { level: "ACCRUING", reason: `Per diem: ${p.days} day(s) past free time; return the empty`, ...base };
    if (p.freeDaysLeft <= 1) return { level: "WATCH", reason: `Per diem starts in ${p.freeDaysLeft} day(s); return the empty or street-turn it`, ...base };
  }
  if (load.direction === "EXPORT" && load.cutoff_at && !AT_TERMINAL_OR_LATER.has(load.status ?? "")) {
    const hours = (Date.parse(load.cutoff_at) - now.getTime()) / 3_600_000;
    if (hours < 0) return { level: "URGENT", reason: "Vessel cutoff has passed; the container will miss the ship", ...base };
    if (hours <= 24) return { level: "URGENT", reason: `Vessel cutoff in ${Math.ceil(hours)} hour(s)`, ...base };
    if (hours <= 48) return { level: "WATCH", reason: "Vessel cutoff within 2 days", ...base };
  }
  return { level: "NONE", reason: "", ...base };
}
