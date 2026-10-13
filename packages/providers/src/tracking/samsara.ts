import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError, type TrackingProvider, type VehiclePosition } from "../types.js";

// Samsara: the latest GPS fix of every vehicle, with an API token from
// Samsara (Settings → API tokens, read access to vehicles). The vehicle's
// Samsara id or name is what a truck's "GPS id" should hold.
export const SAMSARA_VARS = ["SAMSARA_API_TOKEN"] as const;

type Stat = { id: string; name?: string; gps?: { time: string; latitude: number; longitude: number; headingDegrees?: number; speedMilesPerHour?: number } };

export function samsara(env: Env): TrackingProvider {
  const v = requireVars(env, "Samsara", [...SAMSARA_VARS]);
  const base = (env.SAMSARA_BASE_URL?.trim() || "https://api.samsara.com").replace(/\/$/, "");
  return {
    name: "Samsara",
    async positions(): Promise<VehiclePosition[]> {
      const out: VehiclePosition[] = [];
      let after = "";
      for (let page = 0; page < 20; page++) {
        const r = await fetchJson<{ data?: Stat[]; pagination?: { endCursor?: string; hasNextPage?: boolean } }>(
          `${base}/fleet/vehicles/stats?types=gps${after ? `&after=${encodeURIComponent(after)}` : ""}`,
          { headers: { authorization: `Bearer ${v.SAMSARA_API_TOKEN}`, accept: "application/json" } },
          (s, body) => new ProviderError("Samsara", s, body),
        );
        for (const s of r.data ?? []) {
          if (!s.gps) continue;
          out.push({ deviceId: s.id, name: s.name ?? s.id, lat: s.gps.latitude, lng: s.gps.longitude, speedMph: Math.round(s.gps.speedMilesPerHour ?? 0), heading: s.gps.headingDegrees ?? 0, at: s.gps.time });
        }
        if (!r.pagination?.hasNextPage || !r.pagination.endCursor) break;
        after = r.pagination.endCursor;
      }
      return out;
    },
  };
}
