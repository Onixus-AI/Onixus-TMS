import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  BILLABLE, CONTAINER_SIZES, CONTAINER_TYPES, DIRECTIONS, DISPATCHABLE, EQUIPMENT_LABELS, EQUIPMENT_RULES, EQUIPMENT_TYPES,
  LOAD_STATUSES, LOAD_TRANSITIONS, TRAILER_KINDS, TRUCK_KINDS, type EquipmentType, type LoadStatus,
} from "@onixus/core";
import { api, ApiError, apiBase, uploadDocument } from "./api";
import { useNav } from "./nav";
import { DoImport, legLabel, legRoute, LegsPanel, MoveFields, PlacesSection, splitPlace, type Leg, type Place } from "./drayage";

// Dispatcher screens: loads, dispatch, containers, fleet, customers. Every
// rule (what truck a load needs, which status comes next) comes from
// @onixus/core, the same code the API enforces.

export type Row = Record<string, any> & { id: string };
type Risk = { level: "NONE" | "WATCH" | "URGENT" | "ACCRUING"; reason: string; demurrage: number; perDiem: number };
export type Load = Row & { load_number?: string; status: LoadStatus; equipment_type: EquipmentType; charges?: { risk: Risk } | null };

export const usd = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
/** The load number, or the start of its id before the database has numbered it. */
export const ref = (l?: Row | null) => (l ? l.load_number ?? l.id.slice(0, 8) : "—");
export const human = (s: string) => s.toLowerCase().replace(/_/g, " ");

export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return "Your session expired. Sign in again.";
  if (e instanceof TypeError) return `Cannot reach the API at ${apiBase}. Is it running?`;
  return e instanceof Error ? e.message : String(e);
}

export function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="error">
      {errorText(error)}
      {error instanceof ApiError && error.problems.length > 0 && (
        <ul>{error.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
    </div>
  );
}

/** GET a path, with reload. */
export function useGet<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(() => {
    if (!path) return;
    setError(null);
    api<T>(path).then(setData, setError);
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/** Run a write, report its error, then refresh. */
export function useAction(after: () => void) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** Form fields → JSON: empty fields are left out, `numbers` are parsed, checkboxes become booleans. */
export function formBody(form: HTMLFormElement, numbers: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.value.trim() !== "") out[el.name] = numbers.includes(el.name) ? Number(el.value) : el.value.trim();
  }
  return out;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label>{label}{children}</label>;
}
export function Select({ name, options, empty, value, onChange, required }: { name: string; options: [string, string][]; empty?: string; value?: string; onChange?: (v: string) => void; required?: boolean }) {
  return (
    <select name={name} value={value} onChange={onChange && ((e) => onChange(e.target.value))} required={required}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
export const enumOptions = (values: readonly string[], labels?: Record<string, string>): [string, string][] => values.map((v) => [v, labels?.[v] ?? human(v)]);

const STATUS_TONE: Partial<Record<LoadStatus, string>> = {
  DRAFT: "s-muted", QUOTED: "s-muted", BOOKED: "s-amber", PLANNED: "s-amber", ASSIGNED: "s-blue", DISPATCHED: "s-blue",
  AT_PICKUP: "s-mint", PICKED_UP: "s-mint", IN_TRANSIT: "s-mint", AT_DELIVERY: "s-mint", DELIVERED: "s-violet", POD_RECEIVED: "s-violet",
  INVOICED: "s-muted", SETTLED: "s-muted", CLOSED: "s-muted", CANCELED: "s-muted", ON_HOLD: "s-red",
};
export function StatusChip({ status }: { status: LoadStatus }) {
  return <span className={`chip ${STATUS_TONE[status] ?? ""}`}><i />{human(status)}</span>;
}

export function PageTitle({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-title">
      <div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

function RiskBadge({ risk }: { risk?: Risk | null }) {
  if (!risk || risk.level === "NONE") return null;
  const cls = risk.level === "WATCH" ? "warning" : risk.level === "URGENT" ? "serious" : "critical";
  const icon = risk.level === "WATCH" ? "◆" : risk.level === "URGENT" ? "▲" : "●";
  return <span className={`status ${cls}`} title={risk.reason}><span aria-hidden="true">{icon}</span> {risk.level === "ACCRUING" ? usd(risk.demurrage + risk.perDiem) : human(risk.level)}</span>;
}

// ── Loads ───────────────────────────────────────────────────────────────────

function NewLoad({ onDone }: { onDone: () => void }) {
  const [type, setType] = useState<EquipmentType>("CONTAINER");
  const customers = useGet<{ customers: Row[] }>("/customers");
  const locations = useGet<{ locations: Row[] }>("/locations");
  const action = useAction(onDone);
  const shippers = (customers.data?.customers ?? []).filter((c) => c.type !== "STEAMSHIP_LINE");
  const lines = (customers.data?.customers ?? []).filter((c) => c.type === "STEAMSHIP_LINE");
  const places: [string, string][] = (locations.data?.locations ?? []).filter((l) => (l.kind ?? "CUSTOMER") === "CUSTOMER").map((l) => [l.id, l.label]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { return_place, empty_pickup_place, ...body } = formBody(e.currentTarget, ["rate", "weight_lbs", "pallet_count", "length_in", "width_in", "height_in", "demurrage_per_day", "per_diem_per_day"]);
    const form = e.currentTarget;
    const move = type === "CONTAINER" ? { ...splitPlace(return_place, "return_terminal_id", "return_location_id"), ...splitPlace(empty_pickup_place, "empty_pickup_terminal_id", "empty_pickup_location_id") } : {};
    const clean = Object.fromEntries(Object.entries({ ...body, ...move }).filter(([, v]) => v !== null));
    action.run(() => api("/loads", { method: "POST", body: clean })).then((ok) => ok && form.reset());
  };
  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>New load</h2>
      <div className="fields">
        <Field label="Equipment"><Select name="equipment_type" value={type} onChange={(v) => setType(v as EquipmentType)} options={enumOptions(EQUIPMENT_TYPES, EQUIPMENT_LABELS)} /></Field>
        <Field label="Customer"><Select name="customer_id" empty="—" options={shippers.map((c) => [c.id, c.company_name])} /></Field>
        {type !== "CONTAINER" && <Field label="Pickup"><Select name="pickup_location_id" empty="—" options={places} /></Field>}
        {type !== "CONTAINER" && <Field label="Delivery"><Select name="delivery_location_id" empty="—" options={places} /></Field>}
        <Field label="Rate ($)"><input name="rate" type="number" min="0" step="0.01" /></Field>
      </div>
      {type === "CONTAINER" && <MoveFields />}
      {type === "CONTAINER" ? (
        <div className="fields">
          <Field label="Container #"><input name="container_number" placeholder="MSCU1234565" /></Field>
          <Field label="Size"><Select name="container_size" empty="—" options={CONTAINER_SIZES.map((s) => [s, `${s}'`])} /></Field>
          <Field label="Type"><Select name="container_type" empty="—" options={enumOptions(CONTAINER_TYPES)} /></Field>
          <Field label="Steamship line"><Select name="steamship_line_id" empty="—" options={lines.map((c) => [c.id, c.company_name])} /></Field>
          <Field label="Booking #"><input name="booking_number" /></Field>
          <Field label="Last free day"><input name="last_free_day" type="date" /></Field>
          <Field label="Demurrage $/day"><input name="demurrage_per_day" type="number" min="0" placeholder="275" /></Field>
          <Field label="Per diem $/day"><input name="per_diem_per_day" type="number" min="0" placeholder="150" /></Field>
        </div>
      ) : (
        <div className="fields">
          <Field label="Commodity"><input name="commodity" /></Field>
          <Field label="Weight (lbs)"><input name="weight_lbs" type="number" min="1" /></Field>
          <Field label="Pallets"><input name="pallet_count" type="number" min="0" /></Field>
          <Field label="Length (in)"><input name="length_in" type="number" min="1" /></Field>
          <Field label="Width (in)"><input name="width_in" type="number" min="1" /></Field>
          <Field label="Height (in)"><input name="height_in" type="number" min="1" /></Field>
          <Field label="Reference / BOL #"><input name="bol_number" /></Field>
          {type === "FLATBED" && <Field label="Securement"><input name="securement" placeholder="tarps, 8 straps" /></Field>}
          {type === "FLATBED" && <Field label="Oversize permit"><input name="oversize_permit" /></Field>}
        </div>
      )}
      <label className="check"><input name="hazmat" type="checkbox" /> Hazmat</label>
      <Problem error={action.error} />
      <button type="submit" className="primary" disabled={action.busy}>Create load</button>
    </form>
  );
}

function LoadDetail({ id, onChange, onClose }: { id: string; onChange: () => void; onClose: () => void }) {
  const { data, error, reload } = useGet<{ load: Load; legs: Leg[]; places: Record<string, Place>; events: Row[]; extras: { code: string; description: string; amount: number }[]; charges: { demurrage: { days: number; amount: number }; perDiem: { days: number; amount: number }; risk: Risk } | null }>(`/loads/${id}`);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const action = useAction(() => {
    reload();
    onChange();
  });
  const frame = (body: ReactNode) => (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Load details">
        <button className="close" aria-label="Close" onClick={onClose}>✕</button>
        {body}
      </aside>
    </>
  );
  if (error) return frame(<Problem error={error} />);
  if (!data) return frame(<p className="muted">Loading…</p>);
  const { load, legs, places, events, charges, extras } = data;
  // Road statuses come from the legs, assignment from dispatch, and
  // invoicing from "create invoice", which bills the charges.
  const ROAD = ["ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "INVOICED"];
  const next = LOAD_TRANSITIONS[load.status].filter((s) => !ROAD.includes(s));
  return frame(
    <div className="stack">
      <div>
        <p className="muted small">{EQUIPMENT_LABELS[load.equipment_type]}{load.direction ? ` · ${human(load.direction)}` : ""}</p>
        <h2 className="drawer-title">{load.equipment_type === "CONTAINER" && load.container_number ? <span className="mono">{load.container_number}</span> : ref(load)} <StatusChip status={load.status} /></h2>
        <p className="muted small">{ref(load)}</p>
      </div>
      <div className="facts small">
        {load.equipment_type === "CONTAINER" ? (
          <>
            <span>{load.direction ? human(load.direction) : "—"} · {load.container_number ?? "no container yet"} {load.container_size && `${load.container_size}'`}</span>
            <span>LFD {load.last_free_day ?? "—"}{load.outgated_at && ` · out-gated ${load.outgated_at.slice(0, 10)}`}{load.empty_returned_at && ` · empty returned ${load.empty_returned_at.slice(0, 10)}`}{load.ingated_at && ` · in-gated ${load.ingated_at.slice(0, 10)}`}</span>
            {(load.vessel || load.bol_number || load.pickup_number) && <span>{[load.vessel && `Vessel ${load.vessel}${load.voyage ? `/${load.voyage}` : ""}`, load.vessel_eta && `ETA ${load.vessel_eta}`, load.bol_number && `B/L ${load.bol_number}`, load.pickup_number && `Pickup # ${load.pickup_number}`, load.customer_reference && `Ref ${load.customer_reference}`].filter(Boolean).join(" · ")}</span>}
          </>
        ) : (
          <span>{load.commodity ?? "—"} · {load.weight_lbs ? `${load.weight_lbs.toLocaleString()} lbs` : "no weight"}{load.pallet_count != null && ` · ${load.pallet_count} pallets`}</span>
        )}
        <span>Rate {usd(load.rate)}{load.hazmat && " · HAZMAT"}</span>
      </div>
      {charges && (
        <div className="clocks">
          <div><span className="muted small">Demurrage</span><strong>{usd(charges.demurrage.amount)}</strong><span className="muted small">{charges.demurrage.days} day(s)</span></div>
          <div><span className="muted small">Per diem</span><strong>{usd(charges.perDiem.amount)}</strong><span className="muted small">{charges.perDiem.days} day(s)</span></div>
          {charges.risk.reason && <div className="clock-note"><RiskBadge risk={charges.risk} /> <span className="small">{charges.risk.reason}</span></div>}
        </div>
      )}
      {extras.length > 0 && (
        <div className="stack tight">
          <strong className="small">Extras earned so far</strong>
          {extras.map((x) => <div key={x.code} className="line small"><span>{x.description}</span><strong>{usd(x.amount)}</strong></div>)}
        </div>
      )}
      <div className="actions">
        {next.map((s) => (
          <button key={s} className={s === "BOOKED" ? "primary" : ""} disabled={action.busy} onClick={() => action.run(() => api(`/loads/${load.id}/status`, { method: "POST", body: { status: s } }))}>{human(s)}</button>
        ))}

        {BILLABLE.includes(load.status) && (
          <button className="primary" disabled={action.busy} onClick={() => action.run(() => api(`/loads/${load.id}/invoice`, { method: "POST", body: {} }))}>create invoice</button>
        )}
      </div>
      <Problem error={action.error} />
      <LegsPanel legs={legs} places={places} onChange={() => { reload(); onChange(); }} />
      <Documents scope="" loadId={load.id} onChange={() => { reload(); onChange(); }} />
      <strong className="small">History</strong>
      <ol className="timeline small muted">
        {events.map((e) => <li key={e.id}>{e.created_at?.slice(0, 16).replace("T", " ")} · {e.from_status ? `${human(e.from_status)} → ` : ""}{human(e.to_status)}{e.note ? ` · ${e.note}` : ""}</li>)}
      </ol>
    </div>,
  );
}

export function Loads() {
  const [equipment, setEquipment] = useState("");
  const [status, setStatus] = useState("");
  const { intent, clearIntent } = useNav();
  const [open, setOpen] = useState<string | null>(intent.loadId ?? null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(Boolean(intent.importOrder));
  const [search, setSearch] = useState("");
  useEffect(clearIntent, []);
  const q = new URLSearchParams({ ...(equipment && { equipment_type: equipment }), ...(status && { status }) }).toString();
  const { data, error, reload } = useGet<{ loads: Load[] }>(`/loads${q ? `?${q}` : ""}`);
  return (
    <div className="stack page">
      <PageTitle title="Loads" sub="Every move, from booked to invoiced.">
        <button className={importing ? "" : "primary"} onClick={() => { setImporting(!importing); setCreating(false); }}>{importing ? "Close import" : "Import delivery order"}</button>
        <button onClick={() => { setCreating(!creating); setImporting(false); }}>{creating ? "Close" : "New load"}</button>
      </PageTitle>
      {importing && <DoImport onDone={reload} />}
      {creating && <NewLoad onDone={reload} />}
      <div className="panel">
      <div className="toolbar">
        <input className="search" type="search" placeholder="Search load, container, booking or B/L" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search loads" />
        <Select name="eq" value={equipment} onChange={setEquipment} empty="All equipment" options={enumOptions(EQUIPMENT_TYPES, EQUIPMENT_LABELS)} />
        <Select name="st" value={status} onChange={setStatus} empty="All statuses" options={enumOptions(LOAD_STATUSES)} />
      </div>
      <Problem error={error} />
      <div className="table-wrap">
      <table>
        <thead><tr><th>Load</th><th>Equipment</th><th>Status</th><th>Container / freight</th><th>LFD</th><th className="num">Rate</th><th></th></tr></thead>
        <tbody>
          {data?.loads.filter((l) => !search.trim() || [l.load_number, l.container_number, l.booking_number, l.bol_number, l.commodity].some((v) => String(v ?? "").toLowerCase().replace(/\s/g, "").includes(search.toLowerCase().replace(/\s/g, "")))).map((l) => (
            <tr key={l.id} onClick={() => setOpen(open === l.id ? null : l.id)} className={open === l.id ? "selected" : ""}>
              <td><strong>{ref(l)}</strong></td>
              <td className="muted">{EQUIPMENT_LABELS[l.equipment_type]}</td>
              <td><StatusChip status={l.status} /></td>
              <td>{l.equipment_type === "CONTAINER" ? <><span className="mono">{l.container_number ?? "—"}</span> <span className="muted">{l.container_size ? `${l.container_size}'` : ""}</span></> : `${l.commodity ?? "—"}${l.weight_lbs ? ` · ${l.weight_lbs.toLocaleString()} lbs` : ""}`}</td>
              <td>{l.last_free_day ?? ""}</td>
              <td className="num">{usd(l.rate)}</td>
              <td><RiskBadge risk={l.charges?.risk} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {data && !data.loads.length && <p className="muted empty">No loads yet. Import a delivery order to start.</p>}
      </div>
      {open && <LoadDetail key={open} id={open} onChange={reload} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export function Dispatch() {
  const board = useGet<{ legs: Leg[]; loads: Load[]; places: Record<string, Place> }>("/legs?status=PLANNED");
  const drivers = useGet<{ drivers: Row[] }>("/drivers?status=AVAILABLE");
  const trucks = useGet<{ trucks: Row[] }>("/trucks?status=AVAILABLE");
  const trailers = useGet<{ trailers: Row[] }>("/trailers?status=AVAILABLE");
  const trips = useGet<{ trips: Row[] }>("/trips");
  const [picked, setPicked] = useState<string[]>([]);
  const refresh = () => [board, drivers, trucks, trailers, trips].forEach((x) => x.reload());
  const action = useAction(refresh);

  const loadById = new Map((board.data?.loads ?? []).map((l) => [l.id, l]));
  const chosen = (board.data?.legs ?? []).filter((l) => picked.includes(l.id)).map((l) => loadById.get(l.load_id)).filter((l): l is Load => !!l);
  const rule = chosen[0] ? EQUIPMENT_RULES[chosen[0].equipment_type] : null;
  // Legs grouped by load, in order.
  const groups = [...new Set((board.data?.legs ?? []).map((l) => l.load_id))].map((id) => ({ load: loadById.get(id), legs: (board.data?.legs ?? []).filter((l) => l.load_id === id).sort((a, b) => a.seq - b.seq) }));
  const fitTrucks = (trucks.data?.trucks ?? []).filter((t) => !rule || rule.trucks.includes(t.kind));
  const fitTrailers = (trailers.data?.trailers ?? []).filter((t) => rule?.trailer && t.kind === rule.trailer);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = { ...formBody(e.currentTarget), leg_ids: picked };
    action.run(() => api("/dispatch", { method: "POST", body })).then((ok) => ok && setPicked([]));
  };
  const tripAction = (id: string, status: string) => action.run(() => api(`/trips/${id}/status`, { method: "POST", body: { status } }));

  return (
    <div className="stack page">
      <PageTitle title="Dispatch" sub="Pick the legs, then the driver and truck. Onixus refuses a trip it can't run and says why." />
      <form className="dispatch" onSubmit={submit}>
        <div className="panel stack">
          <div className="panel-head"><h2>Legs waiting for a truck</h2><span className="muted small">{board.data?.legs.length ?? 0}</span></div>
          <p className="muted small">A live unload is usually both legs on one trip; for a drop, send the loaded leg now and the empty later. Two containers make a dual transaction.</p>
          {groups.map(({ load, legs }) => (
            <div key={legs[0].load_id} className={`leg-group ${legs.some((l) => picked.includes(l.id)) ? "picked" : ""}`}>
              <div className="leg-head"><strong className="mono">{load?.container_number ?? ref(load)}</strong> <span className="muted small">{ref(load)} · {load ? EQUIPMENT_LABELS[load.equipment_type] : ""}{load?.commodity ? ` · ${load.commodity}` : ""}</span> <RiskBadge risk={load?.charges?.risk} /></div>
              {legs.map((l) => (
                <label key={l.id} className="check leg">
                  <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, ...legs.filter((x) => x.seq <= l.seq && !picked.includes(x.id)).map((x) => x.id)] : picked.filter((x) => !legs.some((y) => y.id === x && y.seq >= l.seq)))} />
                  Leg {l.seq} · {legLabel(l)} · {legRoute(l, board.data!.places)}{l.appointment_at ? ` · appt ${new Date(l.appointment_at).toLocaleString()}` : ""}
                </label>
              ))}
            </div>
          ))}
          {board.data && !groups.length && <p className="muted empty">No legs waiting for a truck. Book a load, or import a delivery order.</p>}
        </div>
        <div className="panel stack builder-side">
        <h2>Trip</h2>
        <p className="small">{picked.length ? `${picked.length} leg${picked.length === 1 ? "" : "s"} picked` : <span className="muted">Pick legs on the left.</span>}</p>
        <div className="stack tight">
          <Field label="Driver"><Select name="driver_id" required empty="Choose…" options={(drivers.data?.drivers ?? []).map((d) => [d.id, `${d.name}${d.cdl_class ? ` (CDL ${d.cdl_class})` : ""}`])} /></Field>
          <Field label="Truck"><Select name="truck_id" required empty="Choose…" options={fitTrucks.map((t) => [t.id, `${t.truck_number} · ${human(t.kind)}`])} /></Field>
          {rule?.trailer && (
            <Field label={rule.trailerRequired ? "Trailer" : "Chassis (optional: pool chassis at the terminal)"}>
              <Select name="trailer_id" required={rule.trailerRequired} empty="—" options={fitTrailers.map((t) => [t.id, `${t.unit_number}${t.size ? ` · ${t.size}'` : ""}`])} />
            </Field>
          )}
        </div>
        <Problem error={action.error} />
        <button type="submit" className="primary" disabled={action.busy || !picked.length}>Assign</button>
        </div>
      </form>

      <section className="panel stack">
      <h2>Trips</h2>
      <div className="table-wrap">
      <table>
        <thead><tr><th>Created</th><th>Status</th><th>Loads</th><th>Legs</th><th></th></tr></thead>
        <tbody>
          {trips.data?.trips.map((t) => (
            <tr key={t.id} className="static">
              <td>{t.created_at?.slice(0, 16).replace("T", " ")}</td>
              <td><span className="chip">{human(t.status)}</span>{t.is_dual_transaction && " · dual"}</td>
              <td>{t.load_ids?.length ?? 0}</td>
              <td>{t.leg_ids?.length ?? 0}</td>
              <td className="actions">
                {t.status === "ASSIGNED" && <button className="primary" onClick={() => tripAction(t.id, "DISPATCHED")}>dispatch</button>}
                {t.status === "DISPATCHED" && <button onClick={() => tripAction(t.id, "COMPLETED")}>complete</button>}
                {["ASSIGNED", "DISPATCHED"].includes(t.status) && <button onClick={() => tripAction(t.id, "CANCELED")}>cancel</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {trips.data && !trips.data.trips.length && <p className="muted">No trips yet.</p>}
      </section>
    </div>
  );
}

// ── Containers: clocks and street turns ─────────────────────────────────────

export function Containers() {
  const alerts = useGet<{ alerts: { load: Load; risk: Risk }[] }>("/containers/alerts");
  const turns = useGet<{ matches: { importLoadId: string; exportLoadId: string; containerNumber: string; miles: number; import: Load; export: Load }[] }>("/street-turns");
  const proposed = useGet<{ loads: Load[] }>("/loads?equipment_type=CONTAINER");
  const action = useAction(() => [alerts, turns, proposed].forEach((x) => x.reload()));
  const pending = (proposed.data?.loads ?? []).filter((l) => l.street_turn_status === "PROPOSED" && l.direction === "IMPORT");
  return (
    <div className="stack page">
      <PageTitle title="Containers" sub="Last free days, per diem, cutoffs and street turns." />
      <section className="panel stack">
      <h2>Container clocks</h2>
      <Problem error={alerts.error} />
      <ul className="list">
        {alerts.data?.alerts.map(({ load, risk }) => (
          <li key={load.id} className="item">
            <RiskBadge risk={risk} /> <strong>{load.container_number ?? ref(load)}</strong> · {risk.reason}
            <div className="muted small">{ref(load)} · {human(load.status)} · LFD {load.last_free_day ?? "—"}</div>
          </li>
        ))}
        {alerts.data && !alerts.data.alerts.length && <li className="muted">No container is near its last free day, per diem or cutoff.</li>}
      </ul>
      </section>

      <section className="panel stack">
      <h2>Street turns</h2>
      <p className="muted small">An emptied import reused for a nearby export on the same line: two fewer port trips and no more per diem. The steamship line must approve each one.</p>
      <Problem error={turns.error ?? action.error} />
      <ul className="list">
        {turns.data?.matches.map((m) => (
          <li key={m.importLoadId} className="item row">
            <span>{m.containerNumber}: {ref(m.import)} → {ref(m.export)} · {m.miles} mi</span>
            <button className="primary" onClick={() => action.run(() => api("/street-turns", { method: "POST", body: { import_load_id: m.importLoadId, export_load_id: m.exportLoadId } }))}>Propose</button>
          </li>
        ))}
        {pending.map((l) => (
          <li key={l.id} className="item row">
            <span>{l.container_number}: {ref(l)} waiting for the line</span>
            <button onClick={() => action.run(() => api(`/street-turns/${l.id}/approve`, { method: "POST" }))}>Approved</button>
            <button onClick={() => action.run(() => api(`/street-turns/${l.id}/reject`, { method: "POST" }))}>Rejected</button>
          </li>
        ))}
        {turns.data && !turns.data.matches.length && !pending.length && <li className="muted">No street-turn matches right now.</li>}
      </ul>
      </section>
    </div>
  );
}

// ── Fleet ───────────────────────────────────────────────────────────────────

function AssetSection({ title, path, columns, fields, numbers = [] }: { title: string; path: "drivers" | "trucks" | "trailers"; columns: [string, (r: Row) => ReactNode][]; fields: ReactNode; numbers?: string[] }) {
  const { data, error, reload } = useGet<Record<string, Row[]>>(`/${path}`);
  const action = useAction(reload);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    action.run(() => api(`/${path}`, { method: "POST", body: formBody(form, numbers) })).then((ok) => ok && form.reset());
  };
  return (
    <section className="panel stack">
      <h2>{title}</h2>
      <Problem error={error} />
      <div className="table-wrap">
      <table>
        <thead><tr>{columns.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{data?.[path]?.map((r) => <tr key={r.id} className="static">{columns.map(([h, f]) => <td key={h}>{f(r)}</td>)}</tr>)}</tbody>
      </table>
      </div>
      <form className="subform stack" onSubmit={submit}>
        <div className="fields">{fields}</div>
        <Problem error={action.error} />
        <button type="submit" disabled={action.busy}>Add</button>
      </form>
    </section>
  );
}

const expiry = (d?: string | null) => d ?? "—";

export function Fleet() {
  const gps = useGet<{ vehicles: { deviceId: string; name: string; lat: number; lng: number; speedMph: number; at: string; truck: Row | null }[] }>("/tracking");
  return (
    <div className="stack page">
      <PageTitle title="Fleet" sub="Drivers, trucks, chassis, your places and live GPS." />
      <AssetSection
        title="Drivers"
        path="drivers"
        columns={[["Name", (r) => r.name], ["CDL", (r) => r.cdl_class ?? "none"], ["Licence", (r) => expiry(r.license_expiry)], ["Medical", (r) => expiry(r.medical_card_expiry)], ["TWIC", (r) => expiry(r.twic_expiry)], ["Hazmat", (r) => (r.hazmat_endorsement ? "yes" : "")], ["Status", (r) => human(r.status ?? "")]]}
        fields={<>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Phone"><input name="phone" /></Field>
          <Field label="CDL class"><Select name="cdl_class" empty="None (cargo van / light box truck)" options={[["A", "A"], ["B", "B"], ["C", "C"]]} /></Field>
          <Field label="Licence expires"><input name="license_expiry" type="date" /></Field>
          <Field label="Medical card expires"><input name="medical_card_expiry" type="date" /></Field>
          <Field label="TWIC expires (ports)"><input name="twic_expiry" type="date" /></Field>
          <label className="check"><input name="hazmat_endorsement" type="checkbox" /> Hazmat endorsement</label>
        </>}
      />
      <AssetSection
        title="Trucks"
        path="trucks"
        numbers={["gvwr_lbs", "max_payload_lbs"]}
        columns={[["Unit", (r) => r.truck_number], ["Kind", (r) => human(r.kind)], ["GVWR", (r) => r.gvwr_lbs?.toLocaleString() ?? "—"], ["Payload", (r) => r.max_payload_lbs?.toLocaleString() ?? "—"], ["GPS id", (r) => r.tracking_device_id ?? ""], ["Status", (r) => human(r.status ?? "")]]}
        fields={<>
          <Field label="Unit #"><input name="truck_number" required /></Field>
          <Field label="Kind"><Select name="kind" options={enumOptions(TRUCK_KINDS)} /></Field>
          <Field label="VIN"><input name="vin" /></Field>
          <Field label="GVWR (lbs)"><input name="gvwr_lbs" type="number" min="1" /></Field>
          <Field label="Max payload (lbs)"><input name="max_payload_lbs" type="number" min="1" /></Field>
          <Field label="GPS tracker id"><input name="tracking_device_id" /></Field>
        </>}
      />
      <AssetSection
        title="Trailers and chassis"
        path="trailers"
        numbers={["max_payload_lbs"]}
        columns={[["Unit", (r) => r.unit_number], ["Kind", (r) => human(r.kind)], ["Size", (r) => r.size ?? "—"], ["Pool", (r) => r.pool ?? ""], ["Status", (r) => human(r.status ?? "")]]}
        fields={<>
          <Field label="Unit #"><input name="unit_number" required /></Field>
          <Field label="Kind"><Select name="kind" options={enumOptions(TRAILER_KINDS)} /></Field>
          <Field label="Size"><input name="size" placeholder="chassis 20/40 · trailer 53" /></Field>
          <Field label="Sub-type"><input name="type" placeholder="tri-axle, step deck…" /></Field>
          <Field label="Chassis pool"><input name="pool" placeholder="DCLI, TRAC…" /></Field>
          <Field label="Max payload (lbs)"><input name="max_payload_lbs" type="number" min="1" /></Field>
        </>}
      />
      <PlacesSection />
      <section className="panel stack">
      <h2>Live GPS</h2>
      {gps.error ? (
        <p className="muted small">GPS is not connected: {errorText(gps.error)}</p>
      ) : (
        <ul className="list">
          {gps.data?.vehicles.map((v) => (
            <li key={v.deviceId} className="item small">
              <strong>{v.truck?.truck_number ?? v.name}</strong> · {v.speedMph} mph · <a href={`https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=13/${v.lat}/${v.lng}`} target="_blank" rel="noreferrer">{v.lat.toFixed(4)}, {v.lng.toFixed(4)}</a> · {new Date(v.at).toLocaleString()}
              {!v.truck && <span className="muted"> · no truck has GPS id {v.deviceId}</span>}
            </li>
          ))}
        </ul>
      )}
      </section>
    </div>
  );
}

// ── Customers, locations, FMCSA ─────────────────────────────────────────────

const CUSTOMER_TYPES = ["SHIPPER", "MANUFACTURER", "BROKER", "FREIGHT_FORWARDER", "STEAMSHIP_LINE", "DEPOT", "WAREHOUSE", "PORT_TERMINAL", "CHASSIS_POOL"];

function CustomerCard({ c, onChange }: { c: Row; onChange: () => void }) {
  const detail = useGet<{ locations: Row[] }>(`/customers/${c.id}`);
  const action = useAction(() => {
    detail.reload();
    onChange();
  });
  const [check, setCheck] = useState<{ status: string; reasons: string[] } | null>(null);
  const addLocation = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    action.run(() => api(`/customers/${c.id}/locations`, { method: "POST", body: formBody(form, ["lat", "lng"]) })).then((ok) => ok && form.reset());
  };
  const badge = c.compliance_status === "VERIFIED" ? "ok" : c.compliance_status === "BLOCKED" ? "bad" : "warn";
  return (
    <li className="panel stack">
      <div>
        <strong>{c.company_name}</strong> <span className="badge">{human(c.type)}</span>{" "}
        {c.dot_number && <span className={`badge ${badge}`}>FMCSA {human(c.compliance_status ?? "pending")}</span>}
        <div className="muted small">{[c.dot_number && `DOT ${c.dot_number}`, c.mc_number && `MC ${c.mc_number}`, c.scac_code && `SCAC ${c.scac_code}`, c.payment_terms].filter(Boolean).join(" · ")}</div>
      </div>
      {c.dot_number && (
        <div className="actions">
          <button disabled={action.busy} onClick={() => action.run(async () => setCheck(await api(`/customers/${c.id}/fmcsa-check`, { method: "POST" })))}>Check FMCSA</button>
          {check && <span className="small">{human(check.status)}{check.reasons.length ? `: ${check.reasons.join("; ")}` : ""}</span>}
        </div>
      )}
      <div className="small">{detail.data?.locations.map((l) => <div key={l.id}>📍 {l.label}{l.city && ` · ${l.city}, ${l.state ?? ""}`}{l.lat == null && <span className="muted"> · no map position (needed for street turns)</span>}</div>)}</div>
      <form className="fields" onSubmit={addLocation}>
        <Field label="New location"><input name="label" required placeholder="Edison DC" /></Field>
        <Field label="City"><input name="city" /></Field>
        <Field label="State"><input name="state" maxLength={2} placeholder="NJ" /></Field>
        <Field label="Lat"><input name="lat" type="number" step="any" /></Field>
        <Field label="Lng"><input name="lng" type="number" step="any" /></Field>
        <button type="submit" disabled={action.busy}>Add</button>
      </form>
      <Problem error={action.error} />
    </li>
  );
}

export function Customers() {
  const { data, error, reload } = useGet<{ customers: Row[] }>("/customers");
  const action = useAction(reload);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    action.run(() => api("/customers", { method: "POST", body: formBody(form) })).then((ok) => ok && form.reset());
  };
  return (
    <div className="stack page">
      <PageTitle title="Customers" sub="Shippers, forwarders, steamship lines and their sites." />
      <form className="panel stack" onSubmit={submit}>
        <h2>New customer</h2>
        <div className="fields">
          <Field label="Company"><input name="company_name" required /></Field>
          <Field label="Type"><Select name="type" options={enumOptions(CUSTOMER_TYPES)} /></Field>
          <Field label="DOT #"><input name="dot_number" inputMode="numeric" /></Field>
          <Field label="MC #"><input name="mc_number" inputMode="numeric" /></Field>
          <Field label="SCAC"><input name="scac_code" maxLength={4} /></Field>
          <Field label="Terms"><input name="payment_terms" placeholder="Net 30" /></Field>
        </div>
        <Problem error={action.error} />
        <button type="submit" className="primary" disabled={action.busy}>Add customer</button>
      </form>
      <Problem error={error} />
      <ul className="list cards">{data?.customers.map((c) => <CustomerCard key={c.id} c={c} onChange={reload} />)}</ul>
    </div>
  );
}

// ── Documents (POD, BOL, rate confirmations, photos) ───────────────────────

const DOC_LABELS: Record<string, string> = { POD: "Proof of delivery", BOL: "Bill of lading", PHOTO: "Photo", RATE_CONFIRMATION: "Rate confirmation", OTHER: "Document" };

export function Documents({ scope, loadId, onChange, compact }: { scope: "" | "/driver"; loadId: string; onChange?: () => void; compact?: boolean }) {
  const { data, reload } = useGet<{ documents: (Row & { kind: string; url: string; file_name?: string })[] }>(`${scope}/loads/${loadId}/documents`);
  const [kind, setKind] = useState("POD");
  const action = useAction(() => {
    reload();
    onChange?.();
  });
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) action.run(() => uploadDocument(scope, loadId, kind, file));
  };
  return (
    <div className="stack">
      {!compact && <strong className="small">Documents</strong>}
      <div className="actions">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Document type">
          <option value="POD">Proof of delivery</option>
          <option value="BOL">Bill of lading</option>
          <option value="PHOTO">Photo</option>
          <option value="RATE_CONFIRMATION">Rate confirmation</option>
          <option value="OTHER">Other</option>
        </select>
        <label className="upload">
          {action.busy ? "Uploading…" : "Take photo / upload"}
          <input type="file" accept="image/*,application/pdf" capture="environment" onChange={pick} disabled={action.busy} hidden />
        </label>
      </div>
      <Problem error={action.error} />
      {data?.documents.map((d) => (
        <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="small">📄 {DOC_LABELS[d.kind] ?? human(d.kind)} · {d.file_name ?? "file"}</a>
      ))}
    </div>
  );
}
