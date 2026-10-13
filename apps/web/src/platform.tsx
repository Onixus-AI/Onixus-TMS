// Platform tools: Onixus's own mailbox, CRM and AI model. They run on the
// platform key (TMS_API_KEY), not on a company account, so only Onixus staff
// who hold that key can use them.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNav } from "./nav";
import { useGet } from "./trucking";
import { apiBase, ApiError, getKey, platformApi as api, setKey, type ProviderStatus } from "./api";

type Mail = { id: string; from: string; subject: string; snippet: string; receivedAt: string };
type Company = { id: string; name: string; domain?: string; type?: string };

const LABELS: Record<string, string> = { email: "Email", crm: "CRM", llm: "AI model", database: "Database", tracking: "GPS tracking" };

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return "The platform key was rejected. Enter it again under Platform key.";
  if (e instanceof TypeError) return `Cannot reach the API at ${apiBase}. Is it running?`;
  return e instanceof Error ? e.message : String(e);
}

function PlatformKey({ onSaved }: { onSaved: () => void }) {
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
        Platform key
        <input type="password" value={key} onChange={(e) => setValue(e.target.value)} placeholder="Platform key (TMS_API_KEY)" autoComplete="off" />
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
      <PlatformKey onSaved={load} />
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

type PlatformTab = "overview" | "mcp" | "email" | "crm" | "ai";

const MCP_TOOLS: [string, string][] = [
  ["get_overview", "the dashboard: loads by stage, money running, moves, what needs a truck"],
  ["search_loads", "open loads by text or status, with container clock risk"],
  ["get_load", "one load by number or container: legs, clocks, extras, emails"],
  ["draft_customer_email", "a customer email drafted from the load's facts"],
  ["send_email", "send it under the company's name, logged on the load"],
];

/** How Onyx (or any MCP client) connects to this company's dispatcher. */
function Mcp() {
  const me = useGet<{ organization: { id: string; name: string } | null }>("/me");
  return (
    <div className="panel stack mcp">
      <h2>Connect Onyx to this dispatcher</h2>
      <p className="muted small">Onixus Dispatcher is an MCP server. Onyx connects to it next to Veltra and Onyx CRM and works this company's loads with the same rules the office uses.</p>
      <div className="stack tight small">
        <div>Server URL <code>{apiBase}/mcp</code> (Streamable HTTP)</div>
        <div>Header <code>Authorization: Bearer &lt;TMS_API_KEY&gt;</code></div>
        <div>Header <code>X-Org-Id: {me.data?.organization?.id ?? "…"}</code></div>
      </div>
      <ul className="list compact small">{MCP_TOOLS.map(([name, what]) => <li key={name}><code>{name}</code> <span className="muted">{what}</span></li>)}</ul>
    </div>
  );
}

export function Platform() {
  const { go } = useNav();
  const [staff, setStaff] = useState(Boolean(getKey()));
  const [tab, setTab] = useState<PlatformTab>("overview");
  const tabs: [PlatformTab, string][] = [["overview", "Platform key"], ["mcp", "Onyx (MCP)"], ["email", "Onixus mailbox"], ["crm", "Onixus CRM"], ["ai", "AI"]];
  // Company owners land here looking for email: send them to Connections, and only show staff tools once the platform key is entered.
  if (!staff)
    return (
      <div className="stack page">
        <div className="panel stack">
          <h2>Onixus staff tools</h2>
          <p className="muted small">This page runs on Onixus's platform key, for Onixus staff. Your company's own email, CRM, books and GPS are under Connections.</p>
          <div className="actions"><button className="primary" onClick={() => go("connections")}>Open Connections</button></div>
        </div>
        <PlatformKey onSaved={() => setStaff(Boolean(getKey()))} />
      </div>
    );
  return (
    <div className="stack">
      <nav className="subnav">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "mcp" && <Mcp />}
      {tab === "email" && <Email />}
      {tab === "crm" && <Crm />}
      {tab === "ai" && <Ai />}
    </div>
  );
}
