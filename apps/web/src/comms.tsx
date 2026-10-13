import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { Field, Problem, useAction, useGet, type Row } from "./trucking";

// Email and AI in the office: an email composer that can draft from the
// load's facts, the log of what was sent, and the "ask" box on the overview.

export type CommsStatus = { email: { provider: string | null; ready: boolean; missing: string[] }; ai: { provider: string | null; ready: boolean; missing: string[] } };

let cached: CommsStatus | null = null;
export function useComms() {
  const [status, setStatus] = useState<CommsStatus | null>(cached);
  useEffect(() => {
    if (!cached) api<CommsStatus>("/comms/status").then((s) => setStatus((cached = s)), () => {});
  }, []);
  return status;
}

const PURPOSES: [string, string][] = [
  ["STATUS_UPDATE", "Status update"],
  ["DELIVERED", "Delivered"],
  ["APPOINTMENT", "Appointment"],
  ["LFD_WARNING", "Last free day warning"],
  ["PER_DIEM", "Return the empty (per diem)"],
];

function NotReady({ what, missing }: { what: string; missing: string[] }) {
  return <p className="notice small">{what} isn't set up yet{missing.length ? `: Onixus needs ${missing.join(", ")} on the API` : ""}.</p>;
}

/** Write (or have the AI draft) an email about a load, then send it. */
export function EmailComposer({ loadId, customerId, onClose, onSent }: { loadId: string; customerId?: string | null; onClose: () => void; onSent: () => void }) {
  const status = useComms();
  const customer = useGet<{ customer: Row }>(customerId ? `/customers/${customerId}` : null);
  const [to, setTo] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  useEffect(() => {
    const email = customer.data?.customer.email;
    if (email) setTo((t) => t || email);
  }, [customer.data]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [purpose, setPurpose] = useState("STATUS_UPDATE");
  const [note, setNote] = useState("");
  const drafting = useAction(() => {});
  const sending = useAction(() => {
    onSent();
    onClose();
  });
  const draft = () =>
    drafting.run(async () => {
      const d = await api<{ subject: string; body: string; to: string | null }>("/assistant/draft-email", { method: "POST", body: { load_id: loadId, purpose, ...(note.trim() && { note: note.trim() }) } });
      setSubject(d.subject);
      setBody(d.body);
      if (!to && d.to) setTo(d.to);
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    sending.run(() => api("/emails", { method: "POST", body: { to, subject, body, load_id: loadId } }));
  };
  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="Email the customer">
      <div className="scrim top" onClick={onClose} />
      <form className="modal panel stack" onSubmit={submit}>
        <div className="panel-head"><h2>Email the customer</h2><button type="button" className="close" aria-label="Close" onClick={onClose}>✕</button></div>
        {status && !status.email.ready && <NotReady what="Sending email" missing={status.email.missing} />}
        <div className="ai-row">
          <span className="ai-badge" aria-hidden="true">✦</span>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="What the email is about">
            {PURPOSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to add (optional)" aria-label="Note for the draft" />
          <button type="button" onClick={draft} disabled={drafting.busy || (status ? !status.ai.ready : false)}>{drafting.busy ? "Drafting…" : "Draft with AI"}</button>
        </div>
        {status && !status.ai.ready && <NotReady what="AI drafting" missing={status.ai.missing} />}
        <Problem error={drafting.error} />
        <Field label="To"><input type="email" required value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" /></Field>
        <Field label="Subject"><input required maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message"><textarea required rows={9} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <p className="muted small">Sent under your company's name; replies come to you.</p>
        <Problem error={sending.error} />
        <div className="actions end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={sending.busy || (status ? !status.email.ready : false)}>{sending.busy ? "Sending…" : "Send"}</button>
        </div>
      </form>
    </div>
  );
}

/** The emails sent about a load or an invoice. */
export function EmailLog({ loadId, version }: { loadId: string; version: number }) {
  const { data, reload } = useGet<{ emails: Row[] }>(`/emails?load_id=${loadId}`);
  useEffect(reload, [version, reload]);
  if (!data?.emails.length) return null;
  return (
    <div className="stack tight">
      <strong className="small">Emails</strong>
      {data.emails.map((e) => (
        <details key={e.id} className="email-item small">
          <summary><span>✉ {e.subject}</span><span className="muted">{e.to_address} · {new Date(e.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></summary>
          <p className="pre muted">{e.body}</p>
        </details>
      ))}
    </div>
  );
}

const SUGGESTIONS = ["Which containers are costing money?", "What's left to dispatch today?", "Which loads can I invoice?", "Summarize today for the owner"];

/** Ask about the company's loads, answered from its own data. */
export function AskBox() {
  const status = useComms();
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<{ q: string; a: string } | null>(null);
  const action = useAction(() => {});
  const ask = (question: string) => {
    if (!question.trim()) return;
    setQ(question);
    action.run(async () => {
      const r = await api<{ answer: string }>("/assistant/ask", { method: "POST", body: { question } });
      setAnswer({ q: question, a: r.answer });
      setQ("");
    });
  };
  const off = status ? !status.ai.ready : false;
  return (
    <div className="ask stack tight">
      {answer && (
        <div className="answer small">
          <p className="muted">{answer.q}</p>
          <p className="pre">{answer.a}</p>
        </div>
      )}
      <Problem error={action.error} />
      {!answer && !off && (
        <div className="chips">
          {SUGGESTIONS.map((s) => <button key={s} type="button" className="ghost small" onClick={() => ask(s)} disabled={action.busy}>{s}</button>)}
        </div>
      )}
      <form className="ask-input" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={off ? "AI isn't set up yet" : "Ask about your loads, containers, money…"} aria-label="Ask Onixus" maxLength={1000} disabled={off || action.busy} />
        <button type="submit" className="send" aria-label="Ask" disabled={off || action.busy || !q.trim()}>{action.busy ? "…" : "✦"}</button>
      </form>
    </div>
  );
}
