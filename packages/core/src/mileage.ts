import type { EquipmentType } from "./equipment.js";

/**
 * Per-mile pricing for lanes without a saved tariff, so a rate request for any origin and
 * destination still gets a price. Each company sets bands per equipment (and container size):
 * a rate per mile, a minimum charge, a fuel surcharge (percent of the base) and whether the
 * move is priced round trip (drayage returns the container or the truck).
 */
export type MileageBand = {
  equipment_type: EquipmentType;
  container_size?: "20" | "40" | "45" | null;
  min_miles: number;
  max_miles?: number | null;
  per_mile: number;
  minimum: number;
  fuel_surcharge: number;
  round_trip: boolean;
};

export type MileagePrice = { band: MileageBand; miles: number; billed_miles: number; base_rate: number; fuel_surcharge: number; total: number };

const cents = (n: number) => Math.round(n * 100) / 100;

/** The band for this move (a size-specific band wins over a general one), or null when none covers it. */
export function mileageBand(bands: MileageBand[], q: { equipment_type: EquipmentType; container_size?: string | null; miles: number }): MileageBand | null {
  const fits = bands.filter((b) => b.equipment_type === q.equipment_type && q.miles >= b.min_miles && (b.max_miles == null || q.miles <= b.max_miles)
    && (!b.container_size || !q.container_size || b.container_size === q.container_size));
  return fits.find((b) => b.container_size && b.container_size === q.container_size) ?? fits.find((b) => !b.container_size) ?? null;
}

export function mileagePrice(bands: MileageBand[], q: { equipment_type: EquipmentType; container_size?: string | null; miles: number }): MileagePrice | null {
  if (!Number.isFinite(q.miles) || q.miles < 0) throw new Error("Miles must be a positive number.");
  const band = mileageBand(bands, q);
  if (!band) return null;
  const billed = Math.round(q.miles * (band.round_trip ? 2 : 1));
  const base = cents(Math.max(band.minimum, billed * band.per_mile));
  const fuel = cents((base * band.fuel_surcharge) / 100);
  return { band, miles: Math.round(q.miles), billed_miles: billed, base_rate: base, fuel_surcharge: fuel, total: cents(base + fuel) };
}

/** Straight-line distance between two points in miles (haversine). */
export function greatCircleMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180, R = 3958.8;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Road miles run longer than straight-line; 1.2 is the usual planning factor. Quotes label these as estimated. */
export const ROAD_FACTOR = 1.2;
