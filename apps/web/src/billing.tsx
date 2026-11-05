import { Fragment, useEffect, useState, type FormEvent } from "react";
import { EQUIPMENT_LABELS } from "@onixus/core";
import { api } from "./api";
import { useComms } from "./comms";
import { providerLabel, useConnections } from "./connections";
import { Field, human, Problem, ref, usd, useAction, useGet, type Load, type Row } from "./trucking";

// Billing: delivered loads with the extras they earned (chassis days,
// waiting, prepull…), checked and edited before the invoice is made; the
// invoices already made; and the company's prices for those extras.

type Line = { code: string; description: string; amount: number; quantity?: number; rate?: number };
type Detail = { load: Load; extras: Line[]; charges: { demurrage: { days: number; amount: number }; perDiem: { days: number; amount: number } } | null };

function InvoiceBuilder({ id, onDone }: { id: string; onDone: () => void }) {
  const { data, error } = useGet<Detail>(`/loads/${id}`);
  const [lines, setLines] = useState<(Line & { on: boolean })[]>([]);
  const [container, setContainer] = useState(true);
  const action = useAction(onDone);
  useEffect(() => {
    if (data) setLines(data.extras.map((l) => ({ ...l, on: true })));
  }, [data]);
  if (error) return <Problem error={error} />;
  if (!data) return <p className="muted small">Working out the charges…</p>;
  const { load, charges } = data;
  const clocks = charges ? charges.demurrage.amount + charges.perDiem.amount : 0;
  const total = (Number(load.rate) || 0) + lines.filter((l) => l.on).reduce((s, l) => s + (Number(l.amount) || 0), 0) + (container ? clocks : 0);
  const set = (i: number, patch: Partial<Line & { on: boolean }>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const create = () =>
    action.run(() =>
      api(`/loads/${id}/invoice`, {
        method: "POST",
        body: { include_container_charges: container, accessorials: lines.filter((l) => l.on).map(({ code, description, amount }) => ({ code, description, amount: Number(amount) || 0 })) },
      }),
    );
  return (
    <div className="builder">
      <div className="line"><span>Line haul · {EQUIPMENT_LABELS[load.equipment_type]}</span><strong>{usd(load.rate)}</strong></div>
      {lines.map((l, i) => (
        <div key={i} className={`line ${l.on ? "" : "off"}`}>
          <label className="check"><input type="checkbox" checked={l.on} onChange={(e) => set(i, { on: e.target.checked })} /> {l.description}</label>
          <input className="amount" type="number" step="0.01" min="0" value={l.amount} aria-label={`${l.code} amount`} onChange={(e) => set(i, { amount: Number(e.target.value) })} />
        </div>
      ))}
      <button className="ghost small" onClick={() => setLines([...lines, { code: "OTHER", description: "Other charge", amount: 0, on: true }])}>+ Add a charge</button>
      {lines.some((l) => l.code === "OTHER") && (
        <div className="fields">
          {lines.map((l, i) => l.code === "OTHER" && (
            <Field key={i} label="Describe the extra charge"><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></Field>
          ))}
        </div>
      )}
      {charges && clocks > 0 && (
        <div className={`line ${container ? "" : "off"}`}>
          <label className="check"><input type="checkbox" checked={container} onChange={(e) => setContainer(e.target.checked)} /> Pass through demurrage ({charges.demurrage.days} d) and per diem ({charges.perDiem.days} d)</label>
          <strong>{usd(clocks)}</strong>
        </div>
      )}
      <div className="line total"><span>Total</span><strong>{usd(total)}</strong></div>
      <Problem error={action.error} />
      <button className="primary" disabled={action.busy} onClick={create}>{action.busy ? "Creating…" : `Create invoice for ${usd(total)}`}</button>
    </div>
  );
}

function InvoiceEmail({ invoice, onDone }: { invoice: Row; onDone: () => void }) {
  const status = useComms();
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const action = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    action.run(() => api(`/invoices/${invoice.id}/email`, { method: "POST", body: { ...(to.trim() && { to: to.trim() }), ...(note.trim() && { note: note.trim() }) } }));
  };
  return (
    <form className="stack tight invoice-email" onSubmit={submit}>
      {status && !status.email.ready && <p className="notice small">Sending email isn't set up yet{status.email.missing.length ? `: Onixus needs ${status.email.missing.join(", ")} on the API` : ""}.</p>}
      <div className="fields">
        <Field label="To (blank: the customer's email on file)"><input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="billing@customer.com" /></Field>
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Please find invoice … below." /></Field>
        <button type="submit" className="primary" disabled={action.busy || (status ? !status.email.ready : false)}>{action.busy ? "Sending…" : "Send invoice"}</button>
      </div>
      <Problem error={action.error} />
    </form>
  );
}

function RateCard({ owner }: { owner: boolean }) {
  const { data, error, reload } = useGet<{ rate_card: Record<string, number> }>("/rate-card");
  const action = useAction(reload);
  const [saved, setSaved] = useState(false);
  const fields: [string, string, string][] = [
    ["chassis_per_day", "Chassis, per day", "$"],
    ["prepull", "Prepull, flat", "$"],
    ["yard_storage_per_day", "Yard storage, per day", "$"],
    ["yard_free_days", "Free yard days", "days"],
    ["waiting_per_hour", "Waiting, per hour", "$"],
    ["waiting_free_hours", "Free waiting hours", "hours"],
    ["overweight", "Overweight, flat", "$"],
    ["overweight_over_lbs", "Overweight above", "lbs"],
    ["hazmat", "Hazmat, flat", "$"],
  ];
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries(fields.map(([k]) => [k, Number(f.get(k))]));
    setSaved(false);
    action.run(() => api("/rate-card", { method: "PUT", body })).then((ok) => ok && setSaved(true));
  };
  if (error) return <Problem error={error} />;
  if (!data) return null;
  return (
    <form className="panel stack" onSubmit={submit} key={JSON.stringify(data.rate_card)}>
      <div className="panel-head">
        <h2>Prices for extras</h2>
        {!owner && <span className="muted small">Only an owner can change these</span>}
      </div>
      <p className="muted small">Onixus suggests these on every delivered container from what actually happened: the chassis days between out-gate and empty return, the hours a live unload ran past the free time, and so on. A price of 0 turns a charge off.</p>
      <div className="fields">
        {fields.map(([k, label, unit]) => (
          <Field key={k} label={`${label} (${unit})`}><input name={k} type="number" min="0" step="any" defaultValue={data.rate_card[k]} disabled={!owner} /></Field>
        ))}
      </div>
      <Problem error={action.error} />
      {owner && <div className="actions"><button type="submit" className="primary" disabled={action.busy}>Save prices</button>{saved && <span className="ok-text small">Saved</span>}</div>}
    </form>
  );
}

type Band = { equipment_type: string; container_size?: string | null; min_miles: number; max_miles?: number | null; per_mile: number; minimum: number; fuel_surcharge: number; round_trip: boolean };
type Quote = { method: string; total: number; base_rate: number; fuel_surcharge: number; miles_estimated?: number; billed_miles?: number; origin?: string; destination?: string };

// Per-mile prices for lanes the company has not saved: any rate request gets a price.
function MileageRates({ owner }: { owner: boolean }) {
  const { data, error, reload } = useGet<{ bands: Band[] }>("/mileage-rates");
  const [bands, setBands] = useState<Band[]>([]);
  const [saved, setSaved] = useState(false);
  const action = useAction(reload);
  const [trial, setTrial] = useState({ origin: "", destination: "", equipment_type: "CONTAINER", container_size: "40" });
  const [quote, setQuote] = useState<Quote | null>(null);
  const tryIt = useAction(() => {});
  useEffect(() => { if (data) setBands(data.bands); }, [data]);
  if (error) return <Problem error={error} />;
  if (!data) return null;
  const set = (i: number, patch: Partial<Band>) => { setSaved(false); setBands(bands.map((b, j) => (j === i ? { ...b, ...patch } : b))); };
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const save = () => action.run(() => api("/mileage-rates", { method: "PUT", body: { bands: bands.map((b) => ({ ...b, container_size: b.equipment_type === "CONTAINER" ? b.container_size || null : null, max_miles: b.max_miles || null })) } })).then((ok) => ok && setSaved(true));
  const run = (e: FormEvent) => {
    e.preventDefault();
    setQuote(null);
    tryIt.run(async () => setQuote(await api<Quote>("/quotes", { method: "POST", body: { ...trial, container_size: trial.equipment_type === "CONTAINER" ? trial.container_size : undefined } })));
  };
  return (
    <section className="panel stack">
      <div className="panel-head"><h2>Per-mile rates</h2>{!owner && <span className="muted small">Only an owner can change these</span>}</div>
      <p className="muted small">Lanes you have not saved are priced from these bands, using estimated road miles between the two ZIP codes or cities. A saved lane always wins. Drayage is usually priced round trip.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Equipment</th><th>Size</th><th className="num">From mi</th><th className="num">To mi</th><th className="num">$ / mile</th><th className="num">Minimum $</th><th className="num">Fuel %</th><th>Round trip</th><th></th></tr></thead>
          <tbody>
            {bands.map((b, i) => (
              <tr key={i} className="static">
                <td><select value={b.equipment_type} disabled={!owner} onChange={(e) => set(i, { equipment_type: e.target.value })}>{Object.entries(EQUIPMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                <td>{b.equipment_type === "CONTAINER" ? <select value={b.container_size ?? ""} disabled={!owner} onChange={(e) => set(i, { container_size: e.target.value || null })}><option value="">Any</option><option>20</option><option>40</option><option>45</option></select> : <span className="muted">—</span>}</td>
                <td><input className="amount" type="number" min="0" value={b.min_miles} disabled={!owner} aria-label="From miles" onChange={(e) => set(i, { min_miles: num(e.target.value) })} /></td>
                <td><input className="amount" type="number" min="0" value={b.max_miles ?? ""} placeholder="no limit" disabled={!owner} aria-label="To miles" onChange={(e) => set(i, { max_miles: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                <td><input className="amount" type="number" min="0" step="0.01" value={b.per_mile} disabled={!owner} aria-label="Rate per mile" onChange={(e) => set(i, { per_mile: num(e.target.value) })} /></td>
                <td><input className="amount" type="number" min="0" step="1" value={b.minimum} disabled={!owner} aria-label="Minimum charge" onChange={(e) => set(i, { minimum: num(e.target.value) })} /></td>
                <td><input className="amount" type="number" min="0" max="100" step="0.1" value={b.fuel_surcharge} disabled={!owner} aria-label="Fuel surcharge percent" onChange={(e) => set(i, { fuel_surcharge: num(e.target.value) })} /></td>
                <td><input type="checkbox" checked={b.round_trip} disabled={!owner} aria-label="Round trip" onChange={(e) => set(i, { round_trip: e.target.checked })} /></td>
                <td>{owner && <button className="ghost small" onClick={() => { setSaved(false); setBands(bands.filter((_, j) => j !== i)); }}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!bands.length && <p className="muted small">No per-mile rates yet. Add a band to price any lane.</p>}
      <Problem error={action.error} />
      {owner && <div className="actions">
        <button className="ghost small" onClick={() => setBands([...bands, { equipment_type: "CONTAINER", container_size: null, min_miles: 0, max_miles: 300, per_mile: 0, minimum: 0, fuel_surcharge: 0, round_trip: true }])}>+ Add a band</button>
        <button className="primary" disabled={action.busy} onClick={save}>Save per-mile rates</button>{saved && <span className="ok-text small">Saved</span>}
      </div>}
      <form className="fields" onSubmit={run}>
        <Field label="Try a quote: from"><input value={trial.origin} onChange={(e) => setTrial({ ...trial, origin: e.target.value })} placeholder="Norfolk, VA 23510" required /></Field>
        <Field label="To"><input value={trial.destination} onChange={(e) => setTrial({ ...trial, destination: e.target.value })} placeholder="Ashland, VA 23005" required /></Field>
        <Field label="Equipment"><select value={trial.equipment_type} onChange={(e) => setTrial({ ...trial, equipment_type: e.target.value })}>{Object.entries(EQUIPMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <button type="submit" disabled={tryIt.busy}>{tryIt.busy ? "Pricing…" : "Price it"}</button>
      </form>
      <Problem error={tryIt.error} />
      {quote && <p className="small"><strong>{usd(quote.total)}</strong> · {quote.method === "mileage" ? `${quote.miles_estimated} estimated miles${quote.billed_miles !== quote.miles_estimated ? `, billed ${quote.billed_miles} round trip` : ""} (${quote.origin} → ${quote.destination})` : "from your saved lane"} · base {usd(quote.base_rate)} + fuel {usd(quote.fuel_surcharge)}</p>}
    </section>
  );
}

export function Billing({ owner }: { owner: boolean }) {
  const ready = useGet<{ loads: Load[] }>("/loads?status=DELIVERED,POD_RECEIVED");
  const invoices = useGet<{ invoices: Row[] }>("/invoices");
  const [open, setOpen] = useState<string | null>(null);
  const [mailing, setMailing] = useState<string | null>(null);
  const conns = useConnections();
  const books = conns.of("finance");
  const push = useAction(() => invoices.reload());
  const refresh = () => {
    setOpen(null);
    ready.reload();
    invoices.reload();
  };
  return (
    <div className="stack page">
      <div className="page-title"><div><h1>Billing</h1><p className="muted">Check the extras each move earned, then invoice.</p></div></div>
      <section className="panel stack">
        <div className="panel-head"><h2>Ready to invoice</h2><span className="muted small">{ready.data?.loads.length ?? 0} delivered</span></div>
        <Problem error={ready.error} />
        {ready.data?.loads.map((l) => (
          <div key={l.id} className={`bill-row ${open === l.id ? "open" : ""}`}>
            <button className="bill-head" aria-expanded={open === l.id} onClick={() => setOpen(open === l.id ? null : l.id)}>
              <span><strong>{ref(l)}</strong> <span className="muted">· {l.container_number ?? l.commodity ?? EQUIPMENT_LABELS[l.equipment_type]}</span></span>
              <span className="chip">{human(l.status)}</span>
              <strong>{usd(l.rate)}</strong>
            </button>
            {open === l.id && <InvoiceBuilder id={l.id} onDone={refresh} />}
          </div>
        ))}
        {ready.data && !ready.data.loads.length && <p className="muted">Nothing delivered is waiting for an invoice.</p>}
      </section>

      <section className="panel stack">
        <h2>Invoices</h2>
        <Problem error={invoices.error ?? push.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Date</th><th>Lines</th><th>Status</th><th className="num">Amount</th><th></th></tr></thead>
            <tbody>
              {invoices.data?.invoices.map((i) => (
                <Fragment key={i.id}>
                <tr className="static">
                  <td>{i.invoice_number ?? i.id.slice(0, 8)}</td>
                  <td>{i.created_at?.slice(0, 10)}</td>
                  <td className="muted">{(i.accessorials ?? []).map((a: Line) => human(a.code)).join(", ")}</td>
                  <td><span className="chip">{human(i.status ?? "draft")}</span></td>
                  <td className="num"><strong>{usd(i.amount)}</strong></td>
                  <td className="actions">
                    {i.status !== "VOID" && <button onClick={() => setMailing(mailing === i.id ? null : i.id)}>{mailing === i.id ? "Close" : i.status === "DRAFT" ? "✉ Email" : "✉ Resend"}</button>}
                    {i.finance_ref ? <span className="chip s-mint"><i />In {i.finance_provider ?? "books"}</span>
                      : books && i.status !== "VOID" && <button disabled={push.busy} onClick={() => push.run(() => api(`/invoices/${i.id}/push`, { method: "POST" }))}>Send to {providerLabel(conns.data, books.provider)}</button>}
                  </td>
                </tr>
                {mailing === i.id && <tr className="static"><td colSpan={6}><InvoiceEmail invoice={i} onDone={() => { setMailing(null); invoices.reload(); }} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {invoices.data && !invoices.data.invoices.length && <p className="muted">No invoices yet.</p>}
      </section>

      <RateCard owner={owner} />
      <MileageRates owner={owner} />
    </div>
  );
}
