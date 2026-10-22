import { useMemo, useState } from "react";
import { EQUIPMENT_LABELS, LEG_NEXT, legActionLabel, type LegStatus } from "@onixus/core";
import { api } from "./api";
import { httpMortuaryClient } from "./mortuary/client";
import { DriverMortuary } from "./mortuary/office";
import { supabase } from "./supabase";
import { Documents, human, Problem, ref, useAction, useGet, type Load, type Row } from "./trucking";
import { legLabel } from "./drayage";

// The driver app: big buttons, one trip at a time, built for a phone in a
// cab. Drivers see only their own trips; owner-operators get it as "My trips".

type Stop = { label?: string; name?: string; kind?: string; address?: string | null; city?: string | null; state?: string | null; zip?: string | null; lat?: number | null; lng?: number | null } | null;
type DriverLeg = Row & { seq: number; cargo: "LOADED" | "EMPTY"; live: boolean; status: LegStatus; to_terminal_id: string | null; from: Stop; to: Stop; load: Load | null; appointment_at?: string | null; appointment_number?: string | null };
type Trip = Row & { status: string; legs: DriverLeg[]; loads: Load[]; is_dual_transaction?: boolean };

function place(s: Stop) {
  if (!s) return "—";
  return [s.label ?? s.name, [s.address, s.city, s.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
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

function LegCard({ leg, tripStatus, current, onChange }: { leg: DriverLeg; tripStatus: string; current: boolean; onChange: () => void }) {
  const action = useAction(onChange);
  const next = LEG_NEXT[leg.status];
  const live = tripStatus === "DISPATCHED" && current && next;
  const load = leg.load;
  const heading = leg.status === "DISPATCHED" || leg.status === "AT_ORIGIN" ? leg.from : leg.to;
  return (
    <div className={`card stack driver-load ${leg.status === "DONE" ? "done" : ""}`}>
      <div className="muted small">Leg {leg.seq} · {legLabel(leg)} · <strong>{human(leg.status)}</strong>{load ? ` · ${ref(load)}` : ""}</div>
      {load && (load.equipment_type === "CONTAINER" ? (
        <div>📦 {load.container_number ?? "container to be assigned"} {load.container_size && `${load.container_size}'`}{load.pickup_number ? ` · Pickup # ${load.pickup_number}` : ""}{load.hazmat ? " · HAZMAT" : ""}</div>
      ) : (
        <div>📦 {EQUIPMENT_LABELS[load.equipment_type]} · {load.commodity ?? "freight"}{load.weight_lbs ? ` · ${load.weight_lbs.toLocaleString()} lbs` : ""}{load.pallet_count != null ? ` · ${load.pallet_count} pallets` : ""}{load.hazmat ? " · HAZMAT" : ""}</div>
      ))}
      <div className="stops">
        <div><span className="muted small">From</span><br />{place(leg.from)} {directions(leg.from) && <a href={directions(leg.from)!} target="_blank" rel="noreferrer">Directions</a>}</div>
        <div><span className="muted small">To</span><br />{place(leg.to)} {directions(leg.to) && <a href={directions(leg.to)!} target="_blank" rel="noreferrer">Directions</a>}</div>
      </div>
      {(leg.appointment_at || leg.appointment_number) && <div className="small">🕑 Appointment {leg.appointment_at ? new Date(leg.appointment_at).toLocaleString() : ""} {leg.appointment_number ? `#${leg.appointment_number}` : ""}</div>}
      {load?.securement && <div className="small">Securement: {load.securement}</div>}
      {load?.notes && <div className="small">Notes: {load.notes}</div>}
      {live && (
        <div className="big-actions">
          <button className="primary" disabled={action.busy} onClick={() => action.run(() => api(`/driver/legs/${leg.id}/advance`, { method: "POST", body: { to: next } }))}>
            {legActionLabel(leg.cargo, leg.live, next, Boolean(leg.to_terminal_id))}
          </button>
          {heading && <span className="muted small">Next stop: {place(heading)}</span>}
        </div>
      )}
      <Problem error={action.error} />
      {/* Paperwork (POD, BOL, photos) belongs to the loaded legs. */}
      {load && leg.cargo === "LOADED" && <Documents scope="/driver" loadId={load.id} onChange={onChange} compact />}
    </div>
  );
}

function TripCard({ trip, onChange }: { trip: Trip; onChange: () => void }) {
  const action = useAction(onChange);
  const [checked, setChecked] = useState("");
  const allDone = trip.legs.every((l) => l.status === "DONE" || l.status === "CANCELED");
  // One leg at a time, in trip order.
  const currentLeg = trip.legs.find((l) => l.status !== "DONE" && l.status !== "CANCELED");
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
      {trip.legs.map((l) => <LegCard key={l.id} leg={l} tripStatus={trip.status} current={l.id === currentLeg?.id} onChange={onChange} />)}
      {trip.status === "DISPATCHED" && allDone && (
        <button className="primary big" disabled={action.busy} onClick={() => action.run(() => api(`/driver/trips/${trip.id}/complete`, { method: "POST" }))}>Finish trip</button>
      )}
    </section>
  );
}

export function DriverApp() {
  const [work, setWork] = useState<"freight" | "mortuary">("freight");
  const mortuary = useMemo(() => httpMortuaryClient(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }), []);
  return (
    <div className="stack">
      <div className="driver-area" role="group" aria-label="Driver work">
        <button type="button" className={work === "freight" ? "active" : ""} aria-pressed={work === "freight"} onClick={() => setWork("freight")}>Freight trips</button>
        <button type="button" className={work === "mortuary" ? "active" : ""} aria-pressed={work === "mortuary"} onClick={() => setWork("mortuary")}>Mortuary legs</button>
      </div>
      {work === "mortuary" ? <DriverMortuary client={mortuary} /> : <FreightTrips />}
    </div>
  );
}

function FreightTrips() {
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
