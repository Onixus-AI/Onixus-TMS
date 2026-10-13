import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError, type TrackingProvider, type VehiclePosition } from "../types.js";

// Motive (formerly KeepTruckin): each vehicle's current location, with an
// API key from the Motive dashboard (Admin → API keys). The vehicle number
// (or id) is what a truck's "GPS id" should hold.
export const MOTIVE_VARS = ["MOTIVE_API_KEY"] as const;

type Loc = { lat?: number; lon?: number; latitude?: number; longitude?: number; located_at?: string; bearing?: number; speed?: number };
type Vehicle = { id: number | string; number?: string; current_location?: Loc | null };

export function motive(env: Env): TrackingProvider {
  const v = requireVars(env, "Motive", [...MOTIVE_VARS]);
  const base = (env.MOTIVE_BASE_URL?.trim() || "https://api.gomotive.com").replace(/\/$/, "");
  return {
    name: "Motive",
    async positions(): Promise<VehiclePosition[]> {
      const out: VehiclePosition[] = [];
      for (let page = 1; page <= 20; page++) {
        const r = await fetchJson<{ vehicles?: { vehicle: Vehicle }[]; pagination?: { total?: number; per_page?: number } }>(
          `${base}/v1/vehicle_locations?per_page=100&page_no=${page}`,
          { headers: { "X-Api-Key": v.MOTIVE_API_KEY, accept: "application/json" } },
          (s, body) => new ProviderError("Motive", s, body),
        );
        const vehicles = r.vehicles ?? [];
        for (const { vehicle } of vehicles) {
          const l = vehicle.current_location;
          const lat = l?.lat ?? l?.latitude, lng = l?.lon ?? l?.longitude;
          if (l == null || lat == null || lng == null) continue;
          out.push({ deviceId: vehicle.number ?? String(vehicle.id), name: vehicle.number ?? String(vehicle.id), lat, lng, speedMph: Math.round(l.speed ?? 0), heading: l.bearing ?? 0, at: l.located_at ?? new Date().toISOString() });
        }
        if (vehicles.length < 100) break;
      }
      return out;
    },
  };
}
