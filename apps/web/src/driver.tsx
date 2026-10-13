import { useState } from "react";
import { EQUIPMENT_LABELS, FINISHED, LOAD_TRANSITIONS, type LoadStatus } from "@onixus/core";
import { api } from "./api";
import { Documents, human, Problem, ref, useAction, useGet, type Load, type Row } from "./trucking";

// The driver app: big buttons, one trip at a time, built for a phone in a
// cab. Drivers see only their own trips; owner-operators get it as "My trips".

const ROAD: LoadStatus[] = ["AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED"];
const LABEL: Partial<Record<LoadStatus, string>> = {
  AT_PICKUP: "Arrived at pickup",
  PICKED_UP: "Loaded / picked up",
  IN_TRANSIT: "In transit",
  AT_DELIVERY: "Arrived at delivery",
  DELIVERED: "Delivered",
};

type Stop = { label?: string; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; lat?: number | null; lng?: number | null } | null;
type DriverLoad = Load & { pickup: Stop; delivery: Stop };
type Trip = Row & { status: string; loads: DriverLoad[]; is_dual_transaction?: boolean };

function place(s: Stop) {
  if (!s) return "—";
  return [s.label, [s.address, s.city, s.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
}
function directions(s: Stop) {
  if (!s) return null;
  const q = s.lat != null && s.lng != null ? `${s.lat},${s.lng}` : [s.address, s.city, s.state, s.zip].filter(Boolean).join(", ");
  return q ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}` : null;
}

/** The phone's position, if the driver allows it. Never blocks a check-in. */
function position(): Promise<{ lat?: number; lng?: number }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

function LoadCard({ load, tripStatus, onChange }: { load: DriverLoad; tripStatus: string; onChange: () => void }) {
  const action = useAction(onChange);
  const next = ROAD.filter((s) => LOAD_TRANSITIONS[load.status].includes(s));
  const live = tripStatus === "DISPATCHED" && !FINISHED.includes(load.status);
  const go = (stop: Stop) => directions(stop);
  return (
    <div className="card stack driver-load">
      <div className="muted small">{ref(load)} · {EQUIPMENT_LABELS[load.equipment_type]} · <strong>{human(load.status)}</strong></div>
      {load.equipment_type === "CONTAINER" ? (
        <div>📦 {load.container_number ?? "container to be assigned"} {load.container_size && `${load.container_size}'`} {load.direction && `· ${human(load.direction)}`}</div>
      ) : (
        <div>📦 {load.commodity ?? "freight"}{load.weight_lbs ? ` · ${load.weight_lbs.toLocaleString()} lbs` : ""}{load.pallet_count != null ? ` · ${load.pallet_count} pallets` : ""}{load.hazmat ? " · HAZMAT" : ""}</div>
      )}
      <div className="stops">
        <div><span className="muted small">Pickup</span><br />{place(load.pickup)} {go(load.pickup) && <a href={go(load.pickup)!} target="_blank" rel="noreferrer">Directions</a>}</div>
        <div><span className="muted small">Delivery</span><br />{place(load.delivery)} {go(load.delivery) && <a href={go(load.delivery)!} target="_blank" rel="noreferrer">Directions</a>}</div>
      </div>
      {load.securement && <div className="small">Securement: {load.securement}</div>}
      {load.notes && <div className="small">Notes: {load.notes}</div>}
      {live && (
        <div className="big-actions">
          {next.map((s) => (
            <button key={s} className="primary" disabled={action.busy} onClick={() => action.run(() => api(`/driver/loads/${load.id}/status`, { method: "POST", body: { status: s } }))}>
              {LABEL[s] ?? human(s)}
            </button>
          ))}
        </div>
      )}
      <Problem error={action.error} />
      <Documents scope="/driver" loadId={load.id} onChange={onChange} compact />
    </div>
  );
}

function TripCard({ trip, onChange }: { trip: Trip; onChange: () => void }) {
  const action = useAction(onChange);
  const [checked, setChecked] = useState("");
  const allDone = trip.loads.every((l) => FINISHED.includes(l.status));
  const checkIn = () =>
    action.run(async () => {
      const at = await position();
      await api(`/driver/trips/${trip.id}/events`, { method: "POST", body: { event_type: "CHECK_CALL", ...at } });
      setChecked(`Checked in at ${new Date().toLocaleTimeString()}${at.lat == null ? " (location off)" : ""}`);
    });
  return (
    <section className="stack">
      <div className="row between">
        <h3>Trip · {human(trip.status)}{trip.is_dual_transaction ? " · dual" : ""}</h3>
        {trip.status === "DISPATCHED" && <button onClick={checkIn} disabled={action.busy}>📍 Check in</button>}
      </div>
      {trip.status === "ASSIGNED" && (
        <button className="primary big" disabled={action.busy} onClick={() => action.run(() => api(`/driver/trips/${trip.id}/start`, { method: "POST" }))}>Start trip</button>
      )}
      {checked && <p className="muted small">{checked}</p>}
      <Problem error={action.error} />
      {trip.loads.map((l) => <LoadCard key={l.id} load={l} tripStatus={trip.status} onChange={onChange} />)}
      {trip.status === "DISPATCHED" && allDone && (
        <button className="primary big" disabled={action.busy} onClick={() => action.run(() => api(`/driver/trips/${trip.id}/complete`, { method: "POST" }))}>Finish trip</button>
      )}
    </section>
  );
}

export function DriverApp() {
  const { data, error, reload } = useGet<{ trips: Trip[]; truck: Row | null; trailer: Row | null }>("/driver/trips");
  const open = data?.trips.filter((t) => t.status !== "COMPLETED") ?? [];
  const done = data?.trips.filter((t) => t.status === "COMPLETED") ?? [];
  return (
    <div className="stack driver">
      <Problem error={error} />
      {data?.truck && <p className="muted small">Truck {data.truck.truck_number}{data.trailer ? ` · ${data.trailer.unit_number}` : ""}</p>}
      {data && !open.length && <p className="card">No trips assigned right now. Tap Refresh when dispatch sends one.</p>}
      {open.map((t) => <TripCard key={t.id} trip={t} onChange={reload} />)}
      <button onClick={reload}>Refresh</button>
      {done.length > 0 && (
        <details>
          <summary className="muted small">Recent finished trips</summary>
          {done.map((t) => <p key={t.id} className="small">{t.completed_at?.slice(0, 10)} · {t.loads.map((l) => ref(l)).join(", ")}</p>)}
        </details>
      )}
    </div>
  );
}
