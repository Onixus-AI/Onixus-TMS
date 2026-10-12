import { fetchJson, requireVars, type Env } from "../env.js";
import { ProviderError, type TrackingProvider, type VehiclePosition } from "../types.js";

// Traccar (traccar.org) is an open-source GPS tracking server (Apache 2.0).
// Drivers run the free Traccar Client phone app, or a hardware tracker
// reports to the server; this reads the latest position of every device.
// Self-host it (docker-compose has a service) or use a hosted Traccar.
export const TRACCAR_VARS = ["TRACCAR_URL", "TRACCAR_TOKEN"] as const;

type Device = { id: number; uniqueId: string; name: string };
type Position = { deviceId: number; latitude: number; longitude: number; speed: number; course: number; fixTime: string };

const KNOTS_TO_MPH = 1.150779;

export function traccar(env: Env): TrackingProvider {
  const v = requireVars(env, "Traccar", [...TRACCAR_VARS]);
  const base = v.TRACCAR_URL.replace(/\/$/, "");
  const get = <T>(path: string) =>
    fetchJson<T>(`${base}${path}`, { headers: { authorization: `Bearer ${v.TRACCAR_TOKEN}`, accept: "application/json" } }, (s, body) => new ProviderError("Traccar", s, body));
  return {
    name: "Traccar",
    async positions(): Promise<VehiclePosition[]> {
      const [devices, positions] = await Promise.all([get<Device[]>("/api/devices"), get<Position[]>("/api/positions")]);
      const byId = new Map(devices.map((d) => [d.id, d]));
      return positions.flatMap((p) => {
        const d = byId.get(p.deviceId);
        if (!d) return [];
        return [{ deviceId: d.uniqueId, name: d.name, lat: p.latitude, lng: p.longitude, speedMph: Math.round(p.speed * KNOTS_TO_MPH), heading: p.course, at: p.fixTime }];
      });
    },
  };
}
