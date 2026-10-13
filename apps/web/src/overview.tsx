import { useEffect, useState } from "react";
import type { Me } from "./App";
import { MovesChart, type Point } from "./chart";
import { useNav } from "./nav";
import { Problem, usd, useGet } from "./trucking";

// The office at a glance: where today's loads are, what is costing money,
// what needs a truck, and the shortest path to each of those screens.

type Overview = {
  as_of: string;
  pipeline: { waiting: number; rolling: number; at_customer: number; to_invoice: number };
  kpis: {
    containers: number;
    at_risk: { amount: number; containers: number };
    moves_today: number;
    moves_yesterday: number;
    ready_to_invoice: { count: number; amount: number };
  };
  queue: { legs_waiting: number; at_terminal: number; at_customer: number; empties_to_return: number; exports_need_empty: number };
  needs_truck: { legs: number; urgent: number; appointment_today: number };
  where: { terminal: number; road: number; yard: number; customer: number };
  series: Point[];
  attention: { load_id: string; load_number: string | null; container_number: string | null; customer: string | null; level: "ACCRUING" | "URGENT" | "WATCH"; reason: string; amount: number; last_free_day: string | null }[];
};

const firstName = (email: string) => {
  const part = email.split("@")[0].split(/[._-]+/)[0] ?? "";
  return part ? part[0].toUpperCase() + part.slice(1) : "there";
};
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
const LEVEL = { ACCRUING: { label: "Costing money", cls: "critical", icon: "●" }, URGENT: { label: "Urgent", cls: "serious", icon: "▲" }, WATCH: { label: "Watch", cls: "warning", icon: "◆" } } as const;

function Pipeline({ p }: { p: Overview["pipeline"] }) {
  const parts = [
    { label: "Waiting for a truck", n: p.waiting, cls: "seg-amber" },
    { label: "On the road", n: p.rolling, cls: "seg-mint" },
    { label: "At the customer", n: p.at_customer, cls: "seg-slate" },
    { label: "To invoice", n: p.to_invoice, cls: "seg-hatch" },
  ];
  const total = parts.reduce((s, x) => s + x.n, 0);
  return (
    <div className="pipeline" aria-label="Where today's loads are">
      {parts.map((x) => (
        <div key={x.label} className="pipe" style={{ flexGrow: Math.max(x.n, total ? total * 0.3 : 1) }}>
          <span className="pipe-label">{x.label}</span>
          <span className={`pipe-bar ${x.cls}`}>{x.n} <small>· {pct(x.n, total)}%</small></span>
        </div>
      ))}
    </div>
  );
}

function Kpi({ value, label, note, tone }: { value: string; label: string; note?: string; tone?: "up" | "down" | "alert" }) {
  return (
    <div className="kpi">
      {<span className={`kpi-note ${tone ?? ""}`}>{tone === "up" ? "↗ " : tone === "down" ? "↘ " : tone === "alert" ? "● " : ""}{note}</span>}
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
    </div>
  );
}

export function Overview({ me }: { me: Me }) {
  const [days, setDays] = useState<7 | 30>(30);
  const { data, error, reload } = useGet<Overview>(`/overview?days=${days}`);
  const { go } = useNav();
  // Keep the board current while it is open.
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <div className="panel"><Problem error={error} /><button onClick={reload}>Try again</button></div>;
  if (!data) return <div className="overview loading"><div className="skeleton tall" /><div className="skeleton" /><div className="skeleton" /></div>;

  const k = data.kpis;
  const diff = k.moves_today - k.moves_yesterday;
  const q = data.queue;
  const whereTotal = data.where.terminal + data.where.road + data.where.yard + data.where.customer;
  const empty = !k.containers && !data.pipeline.waiting && !data.pipeline.rolling && !k.ready_to_invoice.count;

  return (
    <div className="overview">
      <section className="hero">
        <div className="hero-left">
          <h1>{greeting()}, <span className="accent-text">{firstName(me.user.email)}</span></h1>
          <p className="muted">{me.organization?.name}, at a glance · updated {new Date(data.as_of).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
          <Pipeline p={data.pipeline} />
        </div>
        <div className="kpis">
          <Kpi value={String(k.containers)} label="Containers in play" />
          <Kpi value={usd(k.at_risk.amount).replace(/\.00$/, "")} label="Demurrage & per diem" note={k.at_risk.containers ? `${k.at_risk.containers} container${k.at_risk.containers === 1 ? "" : "s"}` : "Nothing accruing"} tone={k.at_risk.containers ? "alert" : undefined} />
          <Kpi value={String(k.moves_today)} label="Moves done today" note={diff === 0 ? "Same as yesterday" : `${Math.abs(diff)} ${diff > 0 ? "more" : "fewer"} than yesterday`} tone={diff > 0 ? "up" : diff < 0 ? "down" : undefined} />
          <Kpi value={usd(k.ready_to_invoice.amount).replace(/\.00$/, "")} label="Ready to invoice" note={`${k.ready_to_invoice.count} load${k.ready_to_invoice.count === 1 ? "" : "s"}`} />
        </div>
      </section>

      {empty && (
        <div className="panel welcome">
          <strong>Nothing moving yet.</strong>
          <span className="muted">Import a delivery order and Onixus books one load per container, plans the legs and starts the clocks.</span>
          <button className="primary" onClick={() => go("loads", { importOrder: true })}>Import a delivery order</button>
        </div>
      )}

      <section className="row-2">
        <div className="panel queue">
          <h2>Work queue</h2>
          {[
            ["Legs waiting for a truck", q.legs_waiting, "dot-amber", () => go("dispatch")],
            ["Containers at the terminal", q.at_terminal, "dot-blue", () => go("containers")],
            ["Containers at the customer", q.at_customer, "dot-mint", () => go("containers")],
            ["Empties to return", q.empties_to_return, "dot-slate", () => go("containers")],
            ["Exports waiting for an empty", q.exports_need_empty, "dot-violet", () => go("containers")],
          ].map(([label, n, dot, onClick]) => (
            <button key={label as string} className="queue-row" onClick={onClick as () => void}>
              <span><i className={`dot ${dot}`} />{label as string}</span>
              <strong>{n as number}</strong>
            </button>
          ))}
          <p className="muted small">Each row opens the screen where you act on it.</p>
        </div>

        <div className="panel volume">
          <div className="panel-head">
            <h2>Moves per day</h2>
            <div className="seg-control" role="group" aria-label="Range">
              {([7, 30] as const).map((d) => <button key={d} className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</button>)}
            </div>
          </div>
          <MovesChart data={data.series} />
        </div>

        <button className="panel cta" onClick={() => go("dispatch")}>
          <div className="panel-head"><h2>Needs a truck</h2><span className="cta-arrow" aria-hidden="true">↗</span></div>
          <p>{data.needs_truck.legs ? `${data.needs_truck.legs} leg${data.needs_truck.legs === 1 ? "" : "s"} have no driver yet.` : "Every leg has a driver."}</p>
          <div className="stack-cards">
            <div className="mini"><span>Last free day today or tomorrow</span><b>{data.needs_truck.urgent}</b></div>
            <div className="mini"><span>Appointment today</span><b>{data.needs_truck.appointment_today}</b></div>
          </div>
        </button>
      </section>

      <section className="row-3">
        <div className="panel where">
          <div className="panel-head"><h2>Where your containers are</h2><span className="muted small">{whereTotal} in play</span></div>
          <div className="bubbles">
            {[
              ["At terminal", data.where.terminal, "b-blue"],
              ["On the road", data.where.road, "b-mint"],
              ["At customer", data.where.customer, "b-slate"],
              ["In our yard", data.where.yard, "b-violet"],
            ].map(([label, n, cls]) => {
              const share = whereTotal ? (n as number) / whereTotal : 0;
              const size = 64 + Math.round(share * 76);
              return (
                <div key={label as string} className={`bubble ${cls}`} style={{ width: size, height: size }}>
                  <strong>{n as number}</strong>
                  <span>{label as string}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel attention">
          <div className="panel-head"><h2>Needs attention</h2><button className="ghost small" onClick={() => go("containers")}>All clocks</button></div>
          {data.attention.length ? (
            <div className="att-grid">
              {data.attention.slice(0, 4).map((a) => (
                <button key={a.load_id} className="att-card" onClick={() => go("loads", { loadId: a.load_id })}>
                  <div className="att-top">
                    <span className={`status ${LEVEL[a.level].cls}`}><span aria-hidden="true">{LEVEL[a.level].icon}</span> {LEVEL[a.level].label}</span>
                    <span className="muted small">{a.load_number ?? ""}</span>
                  </div>
                  <strong className="mono">{a.container_number ?? "No container yet"}</strong>
                  <span className="small">{a.reason}</span>
                  <span className="muted small">{[a.customer, a.amount ? `${usd(a.amount).replace(/\.00$/, "")} so far` : a.last_free_day ? `LFD ${a.last_free_day}` : null].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">No container is near its last free day, per diem or cutoff.</p>
          )}
        </div>

        <div className="panel actions-panel">
          <p className="muted small">Hi, {firstName(me.user.email)}</p>
          <h2 className="big-q">What do you need to do?</h2>
          <div className="quick">
            <button onClick={() => go("loads", { importOrder: true })}><span className="qi qi-mint">⇪</span>Import delivery order</button>
            <button onClick={() => go("dispatch")}><span className="qi qi-amber">⟶</span>Build a trip</button>
            <button onClick={() => go("containers")}><span className="qi qi-blue">↺</span>Street turns</button>
            <button onClick={() => go("billing")}><span className="qi qi-violet">$</span>Create invoices</button>
          </div>
        </div>
      </section>
    </div>
  );
}
