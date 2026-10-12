import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, apiBase, ApiError, getKey, setKey, type ProviderStatus } from "./api";
import { Containers, Customers, Dispatch, Fleet, Loads } from "./trucking";

type Tab = "loads" | "dispatch" | "containers" | "fleet" | "customers" | "overview" | "email" | "crm" | "ai";
type Mail = { id: string; from: string; subject: string; snippet: string; receivedAt: string };
type Company = { id: string; name: string; domain?: string; type?: string };

const LABELS: Record<string, string> = { email: "Email", crm: "CRM", llm: "AI model", database: "Database", tracking: "GPS tracking" };

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return "The API key was rejected. Enter it again under Connections.";
  if (e instanceof TypeError) return `Cannot reach the API at ${apiBase}. Is it running?`;
  return e instanceof Error ? e.message : String(e);
}

function Connections({ onSaved }: { onSaved: () => void }) {
  const [key, setValue] = useState(getKey());
  return (
    <form
      className="card row"
      onSubmit={(e) => {
        e.preventDefault();
        setKey(key.trim());
        onSaved();
      }}
    >
      <label>
        API key
        <input type="password" value={key} onChange={(e) => setValue(e.target.value)} placeholder="TMS_API_KEY" autoComplete="off" />
      </label>
      <button type="submit">Connect</button>
    </form>
  );
}

function Overview() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    api<{ providers: ProviderStatus[] }>("/providers").then((r) => setProviders(r.providers), (e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <Connections onSaved={load} />
      {error && <p className="error">{error}</p>}
      <div className="grid">
        {providers?.map((p) => (
          <div key={p.capability} className="card">
            <div className="muted">{LABELS[p.capability] ?? p.capability}</div>
            <h3>{p.provider}</h3>
            {!p.available ? (
              <span className="badge soon">Coming soon</span>
            ) : p.configured ? (
              <span className="badge ok">Connected</span>
            ) : (
              <>
                <span className="badge warn">Needs setup</span>
                <p className="muted small">Set {p.missing.join(", ")}</p>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Email() {
  const [mail, setMail] = useState<Mail[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ messages: Mail[] }>("/email/unread?limit=20").then((r) => setMail(r.messages), (e) => setError(errorText(e)));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!mail) return <p className="muted">Loading unread mail…</p>;
  if (!mail.length) return <p className="muted">No unread mail.</p>;
  return (
    <ul className="list">
      {mail.map((m) => (
        <li key={m.id} className="card">
          <strong>{m.subject || "(no subject)"}</strong>
          <div className="muted small">
            {m.from} · {new Date(m.receivedAt).toLocaleString()}
          </div>
          <p>{m.snippet}</p>
        </li>
      ))}
    </ul>
  );
}

function Crm() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Company[] | null>(null);
  const [error, setError] = useState("");
  const search = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    api<{ companies: Company[] }>(`/crm/companies?q=${encodeURIComponent(q)}`).then((r) => setRows(r.companies), (err) => setError(errorText(err)));
  };
  return (
    <>
      <form className="card row" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shippers, manufacturers, brokers" required />
        <button type="submit">Search</button>
      </form>
      {error && <p className="error">{error}</p>}
      {rows && !rows.length && <p className="muted">No matches.</p>}
      <ul className="list">
        {rows?.map((c) => (
          <li key={c.id} className="card">
            <strong>{c.name}</strong> {c.type && <span className="badge">{c.type}</span>}
            {c.domain && <div className="muted small">{c.domain}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Ai() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<{ text: string; provider: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setAnswer(await api("/llm/complete", { method: "POST", body: { prompt, maxTokens: 2000 } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="card" onSubmit={ask}>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="e.g. Draft a rate-quote reply for a 40' container from Port Newark to Edison, NJ" required />
        <button type="submit" disabled={busy}>{busy ? "Thinking…" : "Ask"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {answer && (
        <div className="card">
          <div className="muted small">
            {answer.provider} · {answer.model}
          </div>
          <p className="pre">{answer.text}</p>
        </div>
      )}
    </>
  );
}

export default function App() {
  // Start on Connections until an API key is entered, then on the load board.
  const [tab, setTab] = useState<Tab>(getKey() ? "loads" : "overview");
  const tabs: [Tab, string][] = [
    ["loads", "Loads"], ["dispatch", "Dispatch"], ["containers", "Containers"], ["fleet", "Fleet"], ["customers", "Customers"],
    ["email", "Email"], ["crm", "CRM"], ["ai", "AI"], ["overview", "Connections"],
  ];
  return (
    <div className="shell">
      <header>
        <h1>Onixus Drayage OS</h1>
        <nav>
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "loads" && <Loads />}
        {tab === "dispatch" && <Dispatch />}
        {tab === "containers" && <Containers />}
        {tab === "fleet" && <Fleet />}
        {tab === "customers" && <Customers />}
        {tab === "overview" && <Overview />}
        {tab === "email" && <Email />}
        {tab === "crm" && <Crm />}
        {tab === "ai" && <Ai />}
      </main>
    </div>
  );
}
