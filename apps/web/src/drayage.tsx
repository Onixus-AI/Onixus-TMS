import { useState, type FormEvent } from "react";
import { CONTAINER_SIZES, CONTAINER_TYPES, LEG_NEXT, legActionLabel, MOVE_LABELS, MOVE_TYPES, type LegStatus, type MoveType } from "@onixus/core";
import { api } from "./api";
import { supabase } from "./supabase";
import { Field, human, Problem, Select, useAction, useGet, type Row } from "./trucking";

// Drayage screens: reading a delivery order into loads, planning a container
// move, the legs of a load, and our own places (yard, depots, terminals).

export type Place = Row & { label?: string; name?: string; kind: string; city?: string | null; state?: string | null };
export type Leg = Row & {
  load_id: string; seq: number; cargo: "LOADED" | "EMPTY"; live: boolean; status: LegStatus;
  from_terminal_id: string | null; from_location_id: string | null; to_terminal_id: string | null; to_location_id: string | null;
  appointment_at?: string | null; appointment_number?: string | null;
};

export const placeName = (p?: Place | null) => (p ? `${p.label ?? p.name ?? "?"}${p.kind === "TERMINAL" ? " (terminal)" : p.kind === "YARD" ? " (yard)" : p.kind === "DEPOT" ? " (depot)" : ""}` : "?");
export const legRoute = (l: Leg, places: Record<string, Place>) =>
  `${placeName(places[l.from_terminal_id ?? l.from_location_id ?? ""])} → ${placeName(places[l.to_terminal_id ?? l.to_location_id ?? ""])}`;
export const legLabel = (l: { cargo: string; live: boolean; to_terminal_id?: string | null }) =>
  l.cargo === "EMPTY" ? (l.live ? "Empty, live load" : "Empty") : l.to_terminal_id ? "Loaded, to terminal" : l.live ? "Loaded, live unload" : "Loaded, drop";

/** Terminals and our own places, for "where does the empty go / come from". */
function usePlaces() {
  const terminals = useGet<{ terminals: Row[] }>("/terminals");
  const locations = useGet<{ locations: Row[] }>("/locations");
  const all = locations.data?.locations ?? [];
  return {
    terminals: (terminals.data?.terminals ?? []).map((t) => [t.id, t.name] as [string, string]),
    customerSites: all.filter((l) => (l.kind ?? "CUSTOMER") === "CUSTOMER").map((l) => [l.id, [l.label, l.city].filter(Boolean).join(", ")] as [string, string]),
    yards: all.filter((l) => l.kind === "YARD").map((l) => [l.id, l.label] as [string, string]),
    terminalsAndDepots: [
      ...(terminals.data?.terminals ?? []).map((t) => [`t:${t.id}`, `${t.name} (terminal)`] as [string, string]),
      ...all.filter((l) => l.kind === "DEPOT" || l.kind === "YARD").map((l) => [`l:${l.id}`, `${l.label} (${human(l.kind)})`] as [string, string]),
    ],
  };
}

/** "t:<id>" or "l:<id>" from a combined select into the two load columns. */
export function splitPlace(value: unknown, terminalKey: string, locationKey: string): Record<string, string | null> {
  const v = typeof value === "string" ? value : "";
  return { [terminalKey]: v.startsWith("t:") ? v.slice(2) : null, [locationKey]: v.startsWith("l:") ? v.slice(2) : null };
}

/** The move fields of a container load: direction, move, terminal, customer site, yard, empty return or pickup. */
export function MoveFields() {
  const places = usePlaces();
  const [direction, setDirection] = useState("IMPORT");
  const [move, setMove] = useState<MoveType>("IMPORT_LIVE");
  const moves = MOVE_TYPES.filter((m) => m.startsWith(direction));
  return (
    <div className="fields">
      <Field label="Import / export"><Select name="direction" value={direction} onChange={(v) => { setDirection(v); setMove(v === "IMPORT" ? "IMPORT_LIVE" : "EXPORT_LIVE"); }} options={[["IMPORT", "Import"], ["EXPORT", "Export"]]} /></Field>
      <Field label="Move"><Select name="move_type" value={move} onChange={(v) => setMove(v as MoveType)} options={moves.map((m) => [m, MOVE_LABELS[m]])} /></Field>
      <Field label={direction === "IMPORT" ? "Pick up at terminal" : "Deliver to terminal"}><Select name="terminal_id" empty="—" options={places.terminals} /></Field>
      {direction === "IMPORT" ? (
        <Field label="Deliver to (consignee)"><Select name="delivery_location_id" empty="—" options={places.customerSites} /></Field>
      ) : (
        <Field label="Load at (shipper)"><Select name="pickup_location_id" empty="—" options={places.customerSites} /></Field>
      )}
      {move === "IMPORT_PREPULL" && <Field label="Prepull to yard"><Select name="yard_location_id" empty="—" options={places.yards} /></Field>}
      {direction === "IMPORT" ? (
        <Field label="Return empty to"><Select name="return_place" empty="Same terminal" options={places.terminalsAndDepots} /></Field>
      ) : (
        <Field label="Pick up empty at"><Select name="empty_pickup_place" empty="Same terminal" options={places.terminalsAndDepots} /></Field>
      )}
    </div>
  );
}

/** The legs of one load, with the office's tap-forward and the terminal appointment. */
export function LegsPanel({ legs, places, onChange }: { legs: Leg[]; places: Record<string, Place>; onChange: () => void }) {
  const action = useAction(onChange);
  if (!legs.length) return <p className="muted small">No legs yet: they are planned when the load is booked.</p>;
  return (
    <div className="stack">
      <strong className="small">Legs</strong>
      <table>
        <thead><tr><th>#</th><th>Leg</th><th>Route</th><th>Status</th><th>Appointment</th><th></th></tr></thead>
        <tbody>
          {legs.map((l) => {
            const next = LEG_NEXT[l.status];
            return (
              <tr key={l.id}>
                <td>{l.seq}</td>
                <td>{legLabel(l)}</td>
                <td>{legRoute(l, places)}</td>
                <td>{human(l.status)}</td>
                <td>
                  <input className="inline" type="datetime-local" defaultValue={l.appointment_at?.slice(0, 16) ?? ""} aria-label="Appointment time"
                    onBlur={(e) => e.target.value !== (l.appointment_at?.slice(0, 16) ?? "") && action.run(() => api(`/legs/${l.id}`, { method: "PATCH", body: { appointment_at: e.target.value ? new Date(e.target.value).toISOString() : null } }))} />
                  <input className="inline" placeholder="Appt #" defaultValue={l.appointment_number ?? ""} aria-label="Appointment number"
                    onBlur={(e) => e.target.value !== (l.appointment_number ?? "") && action.run(() => api(`/legs/${l.id}`, { method: "PATCH", body: { appointment_number: e.target.value || null } }))} />
                </td>
                <td>{next && <button disabled={action.busy} onClick={() => action.run(() => api(`/legs/${l.id}/advance`, { method: "POST", body: {} }))}>{legActionLabel(l.cargo, l.live, next, Boolean(l.to_terminal_id))}</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Problem error={action.error} />
    </div>
  );
}

type Draft = {
  path: string | null;
  order: Record<string, any>;
  containers: { container_number: string | null; size: string | null; type: string | null; weight_lbs: number | null; seal_number: string | null; problem: string | null }[];
  matches: { customer_id: string | null; steamship_line_id: string | null; terminal_id: string | null; site_location_id: string | null };
};

/** Upload or paste a delivery order, check what the AI read, create the loads. */
export function DoImport({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [result, setResult] = useState<{ loads: Row[]; problems: Record<string, string[]> } | null>(null);
  const reading = useAction(() => {});
  const creating = useAction(onDone);
  const customers = useGet<{ customers: Row[] }>("/customers");
  const places = usePlaces();
  const lines = (customers.data?.customers ?? []).filter((c) => c.type === "STEAMSHIP_LINE");
  const others = (customers.data?.customers ?? []).filter((c) => c.type !== "STEAMSHIP_LINE");

  const read = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get("file") as File | null;
    const text = String(f.get("text") ?? "");
    setResult(null);
    reading.run(async () => {
      let path: string | undefined;
      if (file && file.size) {
        const up = await api<{ path: string; token: string }>("/delivery-orders/upload-url", { method: "POST", body: { file_name: file.name, content_type: file.type || "application/pdf" } });
        const { error } = await supabase.storage.from("documents").uploadToSignedUrl(up.path, up.token, file, { contentType: file.type || "application/pdf" });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        path = up.path;
      }
      setDraft(await api<Draft>("/delivery-orders/read", { method: "POST", body: { path, text: text || undefined } }));
    });
  };

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!draft) return;
    const f = new FormData(e.currentTarget);
    const get = (k: string) => (String(f.get(k) ?? "").trim() || undefined);
    const o = draft.order;
    const direction = get("direction") ?? "IMPORT";
    const pick = (field: string, makeNew: () => unknown, newKey: string) => (get(field) === "__new" ? { [newKey]: makeNew() } : get(field) ? { [field]: get(field) } : {});
    const body = {
      direction, move_type: get("move_type"), rate: get("rate") ? Number(get("rate")) : undefined, path: draft.path ?? undefined, book: true,
      ...pick("customer_id", () => ({ company_name: o.customer_name }), "new_customer"),
      ...pick("steamship_line_id", () => ({ company_name: o.steamship_line_name ?? o.steamship_line_scac, scac_code: o.steamship_line_scac ?? undefined }), "new_steamship_line"),
      ...pick("terminal_id", () => ({ name: o.terminal_name }), "new_terminal"),
      ...pick("site_location_id", () => ({ name: o.site?.name ?? "Delivery site", address: o.site?.address ?? undefined, city: o.site?.city ?? undefined, state: o.site?.state ?? undefined, zip: o.site?.zip ?? undefined }), "new_site"),
      customer_reference: get("customer_reference"), bill_of_lading: get("bill_of_lading"), booking_number: get("booking_number"), pickup_number: get("pickup_number"),
      vessel: get("vessel"), voyage: get("voyage"), vessel_eta: get("vessel_eta"), last_free_day: get("last_free_day"),
      cutoff_at: get("cutoff_at") ? new Date(get("cutoff_at")!).toISOString() : undefined, commodity: get("commodity"), hazmat: f.get("hazmat") === "on", notes: get("notes"),
      containers: draft.containers.map((_, i) => ({
        container_number: get(`c${i}_number`), size: get(`c${i}_size`), type: get(`c${i}_type`),
        weight_lbs: get(`c${i}_weight`) ? Number(get(`c${i}_weight`)) : undefined, seal_number: get(`c${i}_seal`),
      })).filter((c) => c.container_number || direction === "EXPORT"),
    };
    creating.run(async () => {
      setResult(await api<{ loads: Row[]; problems: Record<string, string[]> }>("/delivery-orders", { method: "POST", body }));
      setDraft(null);
    });
  };

  const o = draft?.order ?? {};
  const withNew = (options: [string, string][], label: string | null | undefined): [string, string][] => (label ? [...options, ["__new", `+ New: ${label}`]] : options);
  return (
    <div className="card stack">
      <h3>Import a delivery order</h3>
      {!draft && (
        <form className="stack" onSubmit={read}>
          <p className="muted small">Upload the DO or booking (PDF or photo), or paste the email. The AI reads it; you check it before anything is created.</p>
          <Field label="Delivery order or booking"><input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /></Field>
          <Field label="…or paste the email"><textarea name="text" rows={4} /></Field>
          <Problem error={reading.error} />
          <button type="submit" disabled={reading.busy}>{reading.busy ? "Reading…" : "Read it"}</button>
        </form>
      )}
      {draft && (
        <form className="stack" onSubmit={create}>
          <p className="muted small">Check what was read. Fields left blank were not on the document.</p>
          <div className="fields">
            <Field label="Import / export"><select name="direction" defaultValue={o.direction ?? "IMPORT"}><option value="IMPORT">Import</option><option value="EXPORT">Export</option></select></Field>
            <Field label="Move"><Select name="move_type" empty="Live" options={MOVE_TYPES.filter((m) => m !== "ONE_WAY").map((m) => [m, MOVE_LABELS[m]])} /></Field>
            <Field label={`Customer${o.customer_name ? ` (DO: ${o.customer_name})` : ""}`}>
              <select name="customer_id" defaultValue={draft.matches.customer_id ?? (o.customer_name ? "__new" : "")}><option value="">—</option>{withNew(others.map((c) => [c.id, c.company_name]), o.customer_name).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label={`Steamship line${o.steamship_line_scac ? ` (${o.steamship_line_scac})` : ""}`}>
              <select name="steamship_line_id" defaultValue={draft.matches.steamship_line_id ?? (o.steamship_line_name || o.steamship_line_scac ? "__new" : "")}><option value="">—</option>{withNew(lines.map((c) => [c.id, c.company_name]), o.steamship_line_name ?? o.steamship_line_scac).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label={`Terminal${o.terminal_name ? ` (DO: ${o.terminal_name})` : ""}`}>
              <select name="terminal_id" defaultValue={draft.matches.terminal_id ?? (o.terminal_name ? "__new" : "")}><option value="">—</option>{withNew(places.terminals, o.terminal_name).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label={`${o.direction === "EXPORT" ? "Load at" : "Deliver to"}${o.site?.name ? ` (DO: ${o.site.name})` : ""}`}>
              <select name="site_location_id" defaultValue={draft.matches.site_location_id ?? (o.site?.name ? "__new" : "")}><option value="">—</option>{withNew(places.customerSites, o.site ? [o.site.name, o.site.city].filter(Boolean).join(", ") : null).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label="Rate per container ($)"><input name="rate" type="number" min="0" step="0.01" /></Field>
            <Field label="Customer ref"><input name="customer_reference" defaultValue={o.customer_reference ?? ""} /></Field>
            <Field label="Bill of lading"><input name="bill_of_lading" defaultValue={o.bill_of_lading ?? ""} /></Field>
            <Field label="Booking #"><input name="booking_number" defaultValue={o.booking_number ?? ""} /></Field>
            <Field label="Pickup / release #"><input name="pickup_number" defaultValue={o.pickup_number ?? ""} /></Field>
            <Field label="Vessel"><input name="vessel" defaultValue={o.vessel ?? ""} /></Field>
            <Field label="Voyage"><input name="voyage" defaultValue={o.voyage ?? ""} /></Field>
            <Field label="Vessel ETA"><input name="vessel_eta" type="date" defaultValue={o.vessel_eta ?? ""} /></Field>
            <Field label="Last free day"><input name="last_free_day" type="date" defaultValue={o.last_free_day ?? ""} /></Field>
            <Field label="Cutoff (export)"><input name="cutoff_at" type="datetime-local" defaultValue={o.cutoff_at?.slice(0, 16) ?? ""} /></Field>
            <Field label="Commodity"><input name="commodity" defaultValue={o.commodity ?? ""} /></Field>
          </div>
          <label className="check"><input name="hazmat" type="checkbox" defaultChecked={Boolean(o.hazmat)} /> Hazmat</label>
          <Field label="Notes"><input name="notes" defaultValue={o.notes ?? ""} /></Field>
          <table>
            <thead><tr><th>Container #</th><th>Size</th><th>Type</th><th>Weight (lbs)</th><th>Seal</th><th></th></tr></thead>
            <tbody>
              {draft.containers.map((c, i) => (
                <tr key={i}>
                  <td><input className="inline" name={`c${i}_number`} defaultValue={c.container_number ?? ""} /></td>
                  <td><select name={`c${i}_size`} defaultValue={c.size ?? ""}><option value="">—</option>{CONTAINER_SIZES.map((s) => <option key={s} value={s}>{s}'</option>)}</select></td>
                  <td><select name={`c${i}_type`} defaultValue={c.type ?? ""}><option value="">—</option>{CONTAINER_TYPES.map((t) => <option key={t} value={t}>{human(t)}</option>)}</select></td>
                  <td><input className="inline" name={`c${i}_weight`} type="number" defaultValue={c.weight_lbs ?? ""} /></td>
                  <td><input className="inline" name={`c${i}_seal`} defaultValue={c.seal_number ?? ""} /></td>
                  <td className="small">{c.problem && <span className="error">{c.problem}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!draft.containers.length && <p className="muted small">No containers were listed (normal for an export booking: one load is created per row you add).</p>}
          <Problem error={creating.error} />
          <div className="actions">
            <button type="submit" disabled={creating.busy}>{creating.busy ? "Creating…" : `Create ${Math.max(draft.containers.length, 1)} load(s)`}</button>
            <button type="button" onClick={() => setDraft(null)}>Start over</button>
          </div>
        </form>
      )}
      {result && (
        <div className="small">
          <p className="ok-text">Created {result.loads.length} load(s): {result.loads.map((l) => `${l.load_number ?? l.id.slice(0, 8)} (${human(l.status)})`).join(", ")}</p>
          {Object.entries(result.problems).map(([k, p]) => <p key={k} className="error">{k} saved as a draft: {p.join("; ")}</p>)}
        </div>
      )}
    </div>
  );
}

/** Our yard, empty depots, and the shared terminal list. */
export function PlacesSection() {
  const locations = useGet<{ locations: Row[] }>("/locations");
  const terminals = useGet<{ terminals: Row[] }>("/terminals");
  const action = useAction(() => {
    locations.reload();
    terminals.reload();
  });
  const add = (path: string, kind?: string) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const body: Record<string, unknown> = { ...(kind ? { kind } : {}) };
    f.forEach((v, k) => { if (String(v).trim()) body[k] = k === "lat" || k === "lng" ? Number(v) : String(v).trim(); });
    action.run(() => api(path, { method: "POST", body })).then((ok) => ok && form.reset());
  };
  const own = (locations.data?.locations ?? []).filter((l) => l.kind === "YARD" || l.kind === "DEPOT");
  return (
    <section className="stack">
      <h3>Places</h3>
      <p className="muted small">Your yard (prepulls and drops), empty-return depots, and port terminals. Map positions let street turns find nearby matches.</p>
      <ul className="list compact small">
        {own.map((l) => <li key={l.id}>{l.kind === "YARD" ? "🏠" : "📦"} {l.label} · {human(l.kind)}{l.city ? ` · ${l.city}` : ""}</li>)}
        {terminals.data?.terminals.map((t) => <li key={t.id}>⚓ {t.name}{t.code ? ` (${t.code})` : ""}</li>)}
      </ul>
      <div className="grid">
        <form className="card stack" onSubmit={add("/locations", "YARD")}><strong className="small">Add yard</strong><input name="label" placeholder="Our yard" required /><input name="city" placeholder="City" /><button type="submit">Add</button></form>
        <form className="card stack" onSubmit={add("/locations", "DEPOT")}><strong className="small">Add empty depot</strong><input name="label" placeholder="Depot name" required /><input name="city" placeholder="City" /><button type="submit">Add</button></form>
        <form className="card stack" onSubmit={add("/terminals")}><strong className="small">Add terminal</strong><input name="name" placeholder="Terminal name" required /><input name="code" placeholder="Code" /><button type="submit">Add</button></form>
      </div>
      <Problem error={action.error} />
    </section>
  );
}
