import { useEffect, useState } from "react";
import { siGmail, siHubspot } from "simple-icons";
import { errorText, type MortuaryClient } from "./client";
import { formatWhen } from "./format";
import { loadOperations } from "./operations";
import type { BoardLeg, FleetOption, MortuaryCase, OperationsSnapshot, QueueId, Role } from "./types";
import { CaseIntake, CaseSections, CaseTable, DispatchBoard, ErrorBlock, LoadingBlock, OperationsDashboard } from "./ui";
import "./mortuary.css";

export type MortuaryTab = "operations" | "cases" | "dispatch" | "international";

export function MortuaryOffice({
  role, client, loadFleet, tab, caseId, queue, onTab, onOpenCase, onQueue,
}: {
  role: Role;
  client: MortuaryClient;
  loadFleet?: () => Promise<{ drivers: FleetOption[]; vehicles: FleetOption[] }>;
  tab: MortuaryTab;
  caseId: string | null;
  queue: QueueId | null;
  onTab: (tab: MortuaryTab) => void;
  onOpenCase: (id: string) => void;
  onQueue: (queue: QueueId | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [cases, setCases] = useState<MortuaryCase[] | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [fleet, setFleet] = useState<{ drivers: FleetOption[]; vehicles: FleetOption[] }>({ drivers: [], vehicles: [] });

  useEffect(() => {
    if (!loadFleet) return;
    let active = true;
    loadFleet().then((next) => { if (active) setFleet(next); }, () => { if (active) setFleet({ drivers: [], vehicles: [] }); });
    return () => { active = false; };
  }, [loadFleet]);

  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([
      loadOperations(client),
      client.listCases({ limit: 100 }),
    ]).then(([next, list]) => {
      if (!active) return;
      setSnapshot(next);
      setCases(list.cases);
      setStale(null);
    }, (reason: unknown) => {
      if (!active) return;
      const message = errorText(reason);
      if (snapshot || cases) setStale(message);
      else setError(message);
    });
    return () => { active = false; };
  }, [client, tick]);

  const reload = () => setTick((value) => value + 1);
  if (!snapshot || !cases) {
    if (error) return <div className="mortuary"><ErrorBlock message={error} onRetry={reload} /></div>;
    return <div className="mortuary"><LoadingBlock label="Loading mortuary operations" /></div>;
  }
  const visible = queue ? cases.filter((item) => snapshot.caseIdsByQueue[queue].includes(item.id)) : cases;
  return (
    <div className="mortuary">
      <p className="m-banner">{client.source === "mock"
        ? "Sample data. Not live operational activity. These records come from the test adapter."
        : "Connected to the TMS mortuary API. This screen does not substitute sample cases. The client follows contract 1.1.0."}</p>
      {tab === "operations" && (
        <>
          <OperationsDashboard snapshot={snapshot} stale={stale} onOpen={(id) => { onQueue(id); onTab("cases"); }} />
          <ConnectionsNote />
        </>
      )}
      {tab === "cases" && !caseId && (
        <div className="m-stack">
          <CaseTable cases={visible} queue={queue} onOpen={onOpenCase} onClearQueue={() => onQueue(null)} />
          {role !== "DRIVER" && <CaseIntake onCreate={async (input) => { const created = await client.createCase(input); onOpenCase(created.case.id); reload(); }} />}
        </div>
      )}
      {tab === "cases" && caseId && <CaseScreen caseId={caseId} role={role} client={client} onChanged={reload} />}
      {tab === "dispatch" && <DispatchScreen client={client} fleet={fleet} canAssign={role !== "DRIVER"} />}
      {tab === "international" && <InternationalList cases={cases.filter((item) => item.international)} onOpen={onOpenCase} />}
    </div>
  );
}

function CaseScreen({ caseId, role, client, onChanged }: { caseId: string; role: Role; client: MortuaryClient; onChanged: () => void }) {
  const [tab, setTab] = useState("overview");
  const [detail, setDetail] = useState<Awaited<ReturnType<MortuaryClient["getCase"]>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client.getCase(caseId).then((next) => { if (active) setDetail(next); }, (reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [client, caseId]);
  if (error) return <ErrorBlock message={error} />;
  if (!detail) return <LoadingBlock label="Loading case" />;
  return <CaseSections detail={detail} tab={tab} onTab={setTab} role={role} client={client} onChanged={onChanged} />;
}

function DispatchScreen({ client, fleet, canAssign }: { client: MortuaryClient; fleet: { drivers: FleetOption[]; vehicles: FleetOption[] }; canAssign: boolean }) {
  const [legs, setLegs] = useState<BoardLeg[] | null>(null);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState("PLANNED");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    let active = true;
    client.dispatchBoard(from, to).then((next) => { if (active) setLegs(next); }, (reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [client, tick]);
  if (error) return <ErrorBlock message={error} />;
  if (!legs) return <LoadingBlock label="Loading the dispatch board" />;
  return (
    <DispatchBoard
      legs={legs}
      mobileStatus={mobile}
      onMobileStatus={setMobile}
      canAssign={canAssign}
      fleet={fleet}
      onAssign={async (leg, driverId, vehicleId) => {
        const saved = await client.assignLeg(leg.case_id, leg.id, { expected_version: leg.version, driver_id: driverId, vehicle_id: vehicleId });
        setTick((value) => value + 1);
        return `Server assigned ${saved.driver_id} and ${saved.vehicle_id}. Version ${saved.version}.`;
      }}
    />
  );
}

function BrandMark({ title, path, hex }: { title: string; path: string; hex: string }) {
  return (
    <svg role="img" aria-label={title} width="22" height="22" viewBox="0 0 24 24" style={{ background: "#fff", borderRadius: 4, padding: 2 }}>
      <title>{title}</title>
      <path fill={`#${hex}`} d={path} />
    </svg>
  );
}

function ConnectionsNote() {
  return (
    <section className="m-panel m-stack">
      <h2>Connections</h2>
      <p className="m-muted">Mail and CRM links open the existing Veltra workspace. They do not receive case detail from this screen. Veltra Mail and Veltra CRM are not verified production-ready.</p>
      <p><a href="https://veltra-model-1.vercel.app/?canvas=mail">Veltra Mail</a> · Unavailable · Not verified production-ready. This screen does not send case mail.</p>
      <p><a href="https://veltra-model-1.vercel.app/?canvas=crm">Veltra CRM</a> · Unavailable · Not verified production-ready. Case records are not written to a CRM from here.</p>
      <p><BrandMark title="Gmail" path={siGmail.path} hex={siGmail.hex} /> Gmail · Not connected. No connection link is offered.</p>
      <p><BrandMark title="HubSpot" path={siHubspot.path} hex={siHubspot.hex} /> HubSpot · Not connected. A case may store an opaque HubSpot reference. This screen does not call HubSpot.</p>
      <p>Signal · Disconnected. Private case data is not sent to Signal.</p>
    </section>
  );
}

function InternationalList({ cases, onOpen }: { cases: MortuaryCase[]; onOpen: (id: string) => void }) {
  return (
    <div className="m-stack">
      <header>
        <h1>International coordination</h1>
        <p className="m-muted">Open a case for the route, requirements, milestones, and staff release. Documents complete and cleared for transport stay separate there.</p>
      </header>
      {cases.length === 0 ? <p className="m-panel">No international cases in the loaded page.</p> : (
        <ul className="m-list">
          {cases.map((item) => (
            <li key={item.id}><button type="button" className="link" onClick={() => onOpen(item.id)}>{item.case_number}</button> · {item.requesting_organization.name} · updated {formatWhen(item.updated_at)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DriverMortuary({ client }: { client: MortuaryClient }) {
  const [legs, setLegs] = useState<BoardLeg[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client.driverLegs().then((next) => { if (active) setLegs(next); }, (reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [client]);
  return (
    <div className="mortuary">
      <p className="m-banner">Your assigned mortuary legs. Freight trips are unchanged.</p>
      {error && <ErrorBlock message={error} />}
      {!legs && !error && <LoadingBlock label="Loading your mortuary legs" />}
      {legs && legs.length === 0 && <p className="m-panel">No mortuary legs are assigned to you.</p>}
      {legs?.map((leg) => (
        <article key={leg.id} className="m-card">
          <strong>{leg.case_number}</strong> · {leg.status}
          <p>{leg.from.name} → {leg.to.name}</p>
          <p className="m-muted">{formatWhen(leg.scheduled_departure_at)}</p>
        </article>
      ))}
    </div>
  );
}
