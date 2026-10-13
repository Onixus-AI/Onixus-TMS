import { useState, type FormEvent } from "react";
import { api } from "./api";
import { Field, PageTitle, Problem, useAction, useGet } from "./trucking";

// The company's own accounts: mailbox, CRM, books and GPS. Owners connect
// and disconnect; everyone sees what is connected and can test it.

type Provider = { id: string; label: string; by: string | null; blurb: string; method: "oauth" | "fields" | "soon"; fields: { name: string; label: string; secret?: boolean; placeholder?: string }[]; ready: boolean; missing: string[] };
type Connection = { id: string; category: string; provider: string; account: string | null; status: "CONNECTED" | "ERROR"; last_error: string | null; connected_by: string | null; updated_at: string };
export type Connections = { encryption: boolean; categories: { category: "email" | "crm" | "finance" | "tracking"; connection: Connection | null; providers: Provider[] }[] };

const CATEGORY: Record<string, { title: string; what: string }> = {
  email: { title: "Email", what: "Customer emails and invoices go out from this mailbox. Without one, Onixus sends under your company's name." },
  crm: { title: "CRM", what: "New customers are added to your CRM, with their billing contact." },
  finance: { title: "Finance", what: "Invoices go to your books with one click, line by line." },
  tracking: { title: "Tracking", what: "Live truck positions on Fleet. Put each truck's GPS id (vehicle id, name or number) on the truck." },
};
const MARK: Record<string, { text: string; cls: string }> = {
  gmail: { text: "G", cls: "m-gmail" }, outlook: { text: "O", cls: "m-outlook" }, hubspot: { text: "H", cls: "m-hubspot" },
  quickbooks: { text: "qb", cls: "m-qb" }, samsara: { text: "S", cls: "m-samsara" }, motive: { text: "M", cls: "m-motive" }, traccar: { text: "T", cls: "m-traccar" },
};

let cached: Connections | null = null;
/** What the company has connected, for screens that offer "send to QuickBooks", "sync to CRM" and the like. */
export function useConnections() {
  const g = useGet<Connections>("/connections");
  if (g.data) cached = g.data;
  const data = g.data ?? cached;
  const of = (category: string) => data?.categories.find((c) => c.category === category)?.connection ?? null;
  return { data, of, reload: g.reload, error: g.error };
}
export const providerLabel = (data: Connections | null, id?: string | null) => data?.categories.flatMap((c) => c.providers).find((p) => p.id === id)?.label ?? id ?? "";

function Mark({ id }: { id: string }) {
  const m = MARK[id] ?? { text: "V", cls: "m-veltra" };
  return <span className={`mark ${m.cls}`} aria-hidden="true">{m.text}</span>;
}

function ProviderTile({ p, current, owner, onChange }: { p: Provider; current: Connection | null; owner: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const action = useAction(onChange);
  const mine = current?.provider === p.id;
  const connect = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    action.run(async () => {
      const r = await api<{ detail: string }>(`/connections/${p.id}`, { method: "POST", body });
      setNote({ ok: true, text: `Connected · ${r.detail}` });
      setOpen(false);
    });
  };
  const signIn = () => action.run(async () => {
    const r = await api<{ url: string }>(`/connections/${p.id}/start`, { method: "POST" });
    window.location.assign(r.url);
  });
  const test = () => action.run(async () => {
    const r = await api<{ ok: boolean; detail: string }>(`/connections/${current!.category}/test`, { method: "POST" });
    setNote({ ok: r.ok, text: r.detail });
  });
  const disconnect = () => {
    if (window.confirm(`Disconnect ${p.label}? Onixus forgets the saved credentials.`)) action.run(() => api(`/connections/${current!.category}`, { method: "DELETE" }));
  };
  return (
    <div className={`tile ${mine ? "on" : ""} ${p.method === "soon" ? "soon" : ""}`}>
      <div className="tile-head">
        <Mark id={p.id} />
        <div className="tile-name">
          <strong>{p.label}</strong>
          {p.by && <span className="muted small">by {p.by}</span>}
        </div>
        {mine ? (
          <span className={`chip ${current!.status === "ERROR" ? "s-red" : "s-mint"}`}><i />{current!.status === "ERROR" ? "Needs attention" : "Connected"}</span>
        ) : p.method === "soon" ? <span className="chip s-muted">Coming soon</span> : null}
      </div>
      <p className="small muted">{mine && current!.account ? <><span className="text">{current!.account}</span>{current!.connected_by ? ` · by ${current!.connected_by}` : ""}</> : p.blurb}</p>
      {mine && current!.status === "ERROR" && current!.last_error && <p className="small error">{current!.last_error}</p>}
      {note && <p className={`small ${note.ok ? "ok-text" : "error"}`}>{note.text}</p>}
      <Problem error={action.error} />
      {open && p.method === "fields" && (
        <form className="stack tight" onSubmit={connect}>
          {p.fields.map((f) => <Field key={f.name} label={f.label}><input name={f.name} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder} required /></Field>)}
          <div className="actions"><button type="submit" className="primary" disabled={action.busy}>{action.busy ? "Checking…" : "Save and check"}</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
      {!open && (
        <div className="actions">
          {mine && <button onClick={test} disabled={action.busy}>{current!.category === "email" ? "Send me a test" : "Test"}</button>}
          {mine && owner && <button className="ghost" onClick={disconnect} disabled={action.busy}>Disconnect</button>}
          {!mine && owner && p.method === "fields" && <button className="primary" onClick={() => setOpen(true)}>{current ? `Switch to ${p.label}` : "Connect"}</button>}
          {!mine && owner && p.method === "oauth" && (p.ready
            ? <button className="primary" onClick={signIn} disabled={action.busy}>{current ? `Switch to ${p.label}` : `Sign in with ${p.label}`}</button>
            : <span className="muted small">Onixus is finishing {p.label} sign-in</span>)}
          {!owner && !mine && p.method !== "soon" && <span className="muted small">An owner can connect this</span>}
        </div>
      )}
    </div>
  );
}

export function ConnectionsPage({ owner, notice }: { owner: boolean; notice?: { ok: boolean; text: string } | null }) {
  const { data: view, reload: refresh, error } = useConnections();
  return (
    <div className="stack page">
      <PageTitle title="Connections" sub="Your own email, CRM, books and GPS. Each category connects one account." />
      {notice && <p className={`panel small ${notice.ok ? "ok-text" : "error"}`}>{notice.text}</p>}
      <Problem error={error} />
      {view && !view.encryption && <p className="notice small">Onixus is finishing its secure storage for connections; connecting is paused until then.</p>}
      {view?.categories.map((c) => (
        <section key={c.category} className="panel stack">
          <div className="panel-head">
            <div><h2>{CATEGORY[c.category].title}</h2><p className="muted small">{CATEGORY[c.category].what}</p></div>
            {c.connection ? <span className="chip s-mint"><i />{providerLabel(view, c.connection.provider)}</span> : <span className="chip s-muted">Not connected</span>}
          </div>
          <div className="tiles">
            {c.providers.map((p) => <ProviderTile key={p.id} p={p} current={c.connection} owner={owner} onChange={refresh} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
