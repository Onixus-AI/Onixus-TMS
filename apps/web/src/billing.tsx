import { Fragment, useEffect, useState, type FormEvent } from "react";
import { EQUIPMENT_LABELS } from "@onixus/core";
import { api } from "./api";
import { useComms } from "./comms";
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

export function Billing({ owner }: { owner: boolean }) {
  const ready = useGet<{ loads: Load[] }>("/loads?status=DELIVERED,POD_RECEIVED");
  const invoices = useGet<{ invoices: Row[] }>("/invoices");
  const [open, setOpen] = useState<string | null>(null);
  const [mailing, setMailing] = useState<string | null>(null);
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
        <Problem error={invoices.error} />
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
                  <td className="actions">{i.status !== "VOID" && <button onClick={() => setMailing(mailing === i.id ? null : i.id)}>{mailing === i.id ? "Close" : i.status === "DRAFT" ? "✉ Email" : "✉ Resend"}</button>}</td>
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
    </div>
  );
}
