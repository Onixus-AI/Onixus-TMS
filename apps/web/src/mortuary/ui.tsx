import { DocumentWorkspace } from "./documents";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { errorText, type CreateCaseInput, type CustodyInput, type MortuaryClient } from "./client";
import { formatMoney, formatWhen, isoToLocalInput, localInputToIso, newRequestKey, placeLine } from "./format";
import { QUEUE_LABELS } from "./operations";
import type { BoardLeg, CaseDetail, Checklist, CustodyPage, FleetOption, InternationalView, Invoice, Leg, MortuaryCase, OperationsSnapshot, QueueId, Quote, Role } from "./types";

export const RELEASE_ACKNOWLEDGEMENT = "I have reviewed the documents and requirements for this case. This is an internal release decision, not legal clearance.";

const STATUS_LABEL: Record<string, string> = {
  INTAKE: "Intake", AWAITING_RELEASE: "Awaiting release", READY_FOR_DISPATCH: "Ready for dispatch", IN_TRANSIT: "In transit",
  ON_HOLD: "On hold", DELIVERED: "Delivered", CLOSED: "Closed", CANCELED: "Canceled",
  PLANNED: "Planned", ASSIGNED: "Assigned", EN_ROUTE: "En route", IN_CUSTODY: "In custody",
};
const SERVICE_LABEL: Record<string, string> = {
  FIRST_CALL_REMOVAL: "First call", DOMESTIC_TRANSFER: "Domestic transfer", AIRPORT_TRANSFER: "Airport transfer",
  INTERNATIONAL_INBOUND: "International inbound", INTERNATIONAL_OUTBOUND: "International outbound",
};

export function human(value: string): string {
  return STATUS_LABEL[value] ?? SERVICE_LABEL[value] ?? value.replaceAll("_", " ").toLowerCase();
}

export function LoadingBlock({ label }: { label: string }) {
  return <p className="m-muted" role="status" aria-busy="true">{label}</p>;
}
export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="m-alert" role="alert"><p>{message}</p>{onRetry && <button type="button" onClick={onRetry}>Try again</button>}</div>;
}
export function EmptyBlock({ title, body }: { title: string; body: string }) {
  return <div className="m-panel"><h2>{title}</h2><p className="m-muted">{body}</p></div>;
}

export function OperationsDashboard({ snapshot, stale, onOpen }: { snapshot: OperationsSnapshot; stale?: string | null; onOpen: (queue: QueueId) => void }) {
  const active = snapshot.metrics.find((metric) => metric.id === "active")?.count ?? 0;
  return (
    <div className="m-stack">
      <header>
        <h1>Mortuary operations</h1>
        <p className="m-muted">Figures as of {formatWhen(snapshot.asOf)}. Restricted case detail stays in the case workspace.</p>
      </header>
      {stale && <p className="m-alert" role="status">Showing the last successful load. {stale}</p>}
      {snapshot.partialError && <p className="m-alert" role="alert">Some checklist or release figures could not be loaded. {snapshot.partialError}</p>}
      <div className="m-metrics">
        {snapshot.metrics.map((metric) => (
          <button key={metric.id} type="button" className="m-metric" onClick={() => onOpen(metric.id)}>
            <span className="m-count">{metric.count}</span>
            <span>{metric.label}</span>
            <span className="m-muted">{metric.detail}</span>
          </button>
        ))}
      </div>
      {active === 0 ? <EmptyBlock title="No active cases" body="Intake, release, dispatch, transit, and holds will show here." /> : (
        <section className="m-panel">
          <h2>Needs attention</h2>
          {snapshot.attention.length === 0 ? <p className="m-muted">Nothing in the missing-document, past-arrival, or staff-approval queues.</p> : (
            <ul className="m-list">
              {snapshot.attention.map((item) => (
                <li key={item.caseId}><button type="button" className="link" onClick={() => onOpen("active")}>{item.caseNumber}</button> · {item.line}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

export function CaseTable({
  cases, queue, onOpen, onClearQueue,
}: {
  cases: MortuaryCase[];
  queue: QueueId | null;
  onOpen: (id: string) => void;
  onClearQueue: () => void;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [service, setService] = useState("");
  const [applied, setApplied] = useState({ q: "", status: "", service: "" });
  const rows = cases.filter((item) => {
    const hay = `${item.case_number} ${item.requesting_organization.name} ${item.origin.name} ${item.destination.name}`.toLowerCase();
    if (applied.q && !hay.includes(applied.q.toLowerCase())) return false;
    if (applied.status && item.status !== applied.status) return false;
    if (applied.service && item.service_type !== applied.service) return false;
    return true;
  });
  return (
    <div className="m-stack">
      <header>
        <h1>Cases</h1>
        <p className="m-muted">Search matches the cases loaded from the API. Restricted detail is not in this list.</p>
      </header>
      {queue && (
        <p className="m-banner">Filtered to {QUEUE_LABELS[queue].label}. <button type="button" className="link" onClick={onClearQueue}>Clear queue filter</button></p>
      )}
      <form className="m-filters" onSubmit={(event) => { event.preventDefault(); setApplied({ q, status, service }); }}>
        <label>Search<input value={q} onChange={(event) => setQ(event.target.value)} placeholder="MC-2419 or a facility" /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Any status</option>{Object.entries(STATUS_LABEL).filter(([key]) => key === key.toUpperCase() && !["PLANNED", "ASSIGNED", "EN_ROUTE", "IN_CUSTODY"].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Service<select value={service} onChange={(event) => setService(event.target.value)}><option value="">Any service</option>{Object.entries(SERVICE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <button type="submit">Apply filters</button>
      </form>
      {rows.length === 0 ? <EmptyBlock title="No cases match" body="Change the filter or clear the queue." /> : (
        <div className="m-table-wrap">
          <table>
            <thead><tr><th>Case</th><th>Status</th><th>Service</th><th>Requesting organization</th><th>Coordinator</th><th>Next action</th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td data-label="Case"><button type="button" className="link" onClick={() => onOpen(item.id)}>{item.case_number}</button></td>
                  <td data-label="Status">{human(item.status)}</td>
                  <td data-label="Service">{human(item.service_type)}</td>
                  <td data-label="Requesting organization">{item.requesting_organization.name}</td>
                  <td data-label="Coordinator">{item.coordinator_member_id ? "Assigned" : "Unassigned"}</td>
                  <td data-label="Next action">{nextAction(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function nextAction(item: MortuaryCase): string {
  if (item.status === "INTAKE") return "Finish intake";
  if (item.status === "AWAITING_RELEASE") return item.international ? "Checklist and staff release are separate" : "Configured checklist still open";
  if (item.status === "READY_FOR_DISPATCH") return "Assign transport";
  if (item.status === "IN_TRANSIT") return "Custody is with transport staff";
  if (item.status === "ON_HOLD") return "Held";
  return human(item.status);
}

export function CaseIntake({ onCreate }: { onCreate: (input: CreateCaseInput) => Promise<void> }) {
  const key = useRef(newRequestKey());
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "saving") return;
    const form = new FormData(event.currentTarget);
    const input: CreateCaseInput = {
      request_key: key.current,
      service_type: String(form.get("service_type")) as CreateCaseInput["service_type"],
      requesting_organization: { name: String(form.get("org") ?? ""), type: String(form.get("org_type") ?? "FUNERAL_HOME") },
      origin: { name: String(form.get("origin") ?? ""), facility_type: "HOSPITAL", country: String(form.get("origin_country") ?? "").toUpperCase() },
      destination: { name: String(form.get("destination") ?? ""), facility_type: "FUNERAL_HOME", country: String(form.get("destination_country") ?? "").toUpperCase() },
    };
    setPhase("saving");
    setMessage("Waiting for the server. The case is not open until the response returns.");
    try {
      await onCreate(input);
      setPhase("saved");
      setMessage("Server opened the case.");
      key.current = newRequestKey();
    } catch (error) {
      setPhase("failed");
      setMessage(errorText(error));
    }
  }
  return (
    <form className="m-panel m-stack" onSubmit={onSubmit}>
      <h2>Open a case</h2>
      <div className="m-filters">
        <label>Service<select name="service_type" defaultValue="DOMESTIC_TRANSFER">{Object.entries(SERVICE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>Requesting organization<input name="org" required minLength={1} /></label>
        <label>Organization type<select name="org_type" defaultValue="FUNERAL_HOME"><option>FUNERAL_HOME</option><option>HOSPITAL</option><option>FAMILY</option><option>AGENT</option><option>OTHER</option></select></label>
        <label>Origin name<input name="origin" required /></label>
        <label>Origin country<input name="origin_country" required minLength={2} maxLength={2} defaultValue="US" /></label>
        <label>Destination name<input name="destination" required /></label>
        <label>Destination country<input name="destination_country" required minLength={2} maxLength={2} defaultValue="US" /></label>
      </div>
      <button type="submit" disabled={phase === "saving"}>{phase === "saving" ? "Waiting for the server" : "Open case"}</button>
      <div aria-live="polite">{phase === "failed" ? <p role="alert">{message}</p> : message && <p role="status">{message}</p>}</div>
    </form>
  );
}

export function DispatchBoard({
  legs, mobileStatus, onMobileStatus, canAssign, fleet, onAssign,
}: {
  legs: BoardLeg[];
  mobileStatus: string;
  onMobileStatus: (status: string) => void;
  canAssign: boolean;
  fleet: { drivers: FleetOption[]; vehicles: FleetOption[] };
  onAssign: (leg: BoardLeg, driverId: string, vehicleId: string) => Promise<string>;
}) {
  const columns = ["PLANNED", "ASSIGNED", "EN_ROUTE", "IN_CUSTODY"] as const;
  return (
    <div className="m-stack">
      <header>
        <h1>Dispatch</h1>
        <p className="m-muted">Mortuary legs from the dispatch board. Freight dispatch stays on the Freight area.</p>
      </header>
      <label className="m-mobile-only">Status<select value={mobileStatus} onChange={(event) => onMobileStatus(event.target.value)}>{columns.map((status) => <option key={status} value={status}>{human(status)}</option>)}</select></label>
      <div className="m-board">
        {columns.map((status) => (
          <section key={status} className={status === mobileStatus ? "m-col" : "m-col m-hide-sm"} aria-label={human(status)}>
            <h2>{human(status)} {legs.filter((leg) => leg.status === status).length}</h2>
            {legs.filter((leg) => leg.status === status).map((leg) => (
              <LegCard key={leg.id} leg={leg} canAssign={canAssign && (leg.status === "PLANNED" || leg.status === "ASSIGNED") && leg.mode === "GROUND"} fleet={fleet} onAssign={onAssign} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function LegCard({ leg, canAssign, fleet, onAssign }: { leg: BoardLeg; canAssign: boolean; fleet: { drivers: FleetOption[]; vehicles: FleetOption[] }; onAssign: (leg: BoardLeg, driverId: string, vehicleId: string) => Promise<string> }) {
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPhase("saving");
    setMessage("Waiting for the server. The assignment is not saved until it answers.");
    try {
      const text = await onAssign(leg, String(form.get("driver_id") ?? ""), String(form.get("vehicle_id") ?? ""));
      setPhase("saved");
      setMessage(text);
    } catch (error) {
      setPhase("failed");
      setMessage(errorText(error));
    }
  }
  return (
    <article className="m-card">
      <strong>{leg.case_number}</strong> <span className="m-status">{human(leg.status)}</span>
      <p>{leg.mode === "GROUND" ? "Ground" : leg.mode === "AIR" ? "Air" : "Partner"} · {placeLine(leg.from)} → {placeLine(leg.to)}</p>
      <p className="m-muted">{formatWhen(leg.scheduled_departure_at)} – {formatWhen(leg.scheduled_arrival_at)}</p>
      <p className="m-muted">{leg.driver_id ? `Driver ${leg.driver_id}` : "No driver assigned"}{leg.carrier?.flight_number ? ` · ${leg.carrier.name} ${leg.carrier.flight_number}` : ""}</p>
      {canAssign && (
        <form onSubmit={onSubmit} className="m-stack">
          <label>Driver<select name="driver_id" required defaultValue=""><option value="" disabled>Select a driver</option>{fleet.drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.label}</option>)}</select></label>
          <label>Vehicle<select name="vehicle_id" required defaultValue=""><option value="" disabled>Select a vehicle</option>{fleet.vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.label}</option>)}</select></label>
          <button type="submit" disabled={phase === "saving"}>{phase === "saving" ? "Waiting for the server" : "Save assignment"}</button>
        </form>
      )}
      <div aria-live="polite">{phase === "failed" ? <p role="alert">{message}</p> : message && <p role="status">{message}</p>}</div>
    </article>
  );
}

export function CustodyForm({ legs, expectedSeq, submit }: { legs: Leg[]; expectedSeq: number; submit: (body: CustodyInput) => Promise<{ event: { id: string; seq: number; recorded_at: string; kind: string }; replayed: boolean }> }) {
  const key = useRef(newRequestKey());
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "saving") return;
    const form = new FormData(event.currentTarget);
    const occurred = localInputToIso(String(form.get("occurred_at") ?? ""));
    if (!occurred || String(form.get("note") ?? "").trim().length < 3) {
      setPhase("failed");
      setMessage("Add the time and how identification was confirmed. Nothing was sent.");
      return;
    }
    const body: CustodyInput = {
      request_key: key.current,
      expected_seq: expectedSeq,
      kind: "IDENTITY_CHECK",
      leg_id: String(form.get("leg_id") ?? "") || null,
      occurred_at: occurred,
      payload: { method: String(form.get("method") ?? "FACILITY_STAFF_CONFIRMATION"), outcome: "VERIFIED", note: String(form.get("note") ?? "") },
    };
    setPhase("saving");
    setMessage("");
    try {
      const result = await submit(body);
      setPhase("saved");
      setMessage(`Server recorded identity check ${result.event.id}, sequence ${result.event.seq}, at ${formatWhen(result.event.recorded_at)}.${result.replayed ? " This was a replay of the same request." : ""}`);
      key.current = newRequestKey();
    } catch (error) {
      setPhase("failed");
      setMessage(errorText(error));
    }
  }
  if (legs.length === 0) return <p className="m-muted">This case has no transport leg for a handoff.</p>;
  return (
    <form className="m-stack" onSubmit={onSubmit}>
      <p className="m-muted">An identity check is confirmed only after the server returns the event. A transfer is a separate event and still requires this check.</p>
      <div className="m-filters">
        <label>Leg<select name="leg_id" defaultValue={legs[0]?.id}>{legs.map((leg) => <option key={leg.id} value={leg.id}>{leg.seq} · {placeLine(leg.from)} to {placeLine(leg.to)}</option>)}</select></label>
        <label>When<input name="occurred_at" type="datetime-local" required defaultValue={isoToLocalInput(new Date().toISOString())} /></label>
        <label>Method<select name="method" defaultValue="FACILITY_STAFF_CONFIRMATION"><option value="FACILITY_STAFF_CONFIRMATION">Facility staff confirmation</option><option value="TAG">Tag</option><option value="WRISTBAND">Wristband</option><option value="PAPERWORK">Paperwork</option></select></label>
      </div>
      <label>How was identification confirmed?<input name="note" minLength={3} required placeholder="Wristband, case reference, or facility tag" /></label>
      <button type="submit" disabled={phase === "saving"}>{phase === "saving" ? "Waiting for the server" : "Record identity check"}</button>
      <div aria-live="polite">
        {phase === "saving" && <p role="status">Waiting for the server. Nothing is recorded until the event returns.</p>}
        {phase === "failed" && <p role="alert">{message}</p>}
        {phase === "saved" && <p className="m-receipt" role="status">{message}</p>}
      </div>
    </form>
  );
}

export function TransferForm({ legs, expectedSeq, submit }: { legs: Leg[]; expectedSeq: number; submit: (body: CustodyInput) => Promise<{ event: { id: string; seq: number; recorded_at: string; kind: string }; replayed: boolean }> }) {
  const key = useRef(newRequestKey());
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "saving") return;
    const form = new FormData(event.currentTarget);
    const occurred = localInputToIso(String(form.get("occurred_at") ?? ""));
    const releasing = String(form.get("releasing") ?? "").trim();
    const receiving = String(form.get("receiving") ?? "").trim();
    if (!occurred || releasing.length < 2 || receiving.length < 2) {
      setPhase("failed");
      setMessage("Add both parties and a time. Nothing was sent.");
      return;
    }
    const acknowledged = occurred;
    const body: CustodyInput = {
      request_key: key.current,
      expected_seq: expectedSeq,
      kind: "TRANSFER",
      leg_id: String(form.get("leg_id") ?? ""),
      occurred_at: occurred,
      payload: {
        releasing_party: { kind: "RELEASING_FACILITY", name: releasing, organization: String(form.get("releasing_org") ?? "") },
        receiving_party: { kind: "TRANSPORT_STAFF", name: receiving },
        location: { name: String(form.get("location") ?? releasing), facility_type: "OTHER", country: "US" },
        releasing_acknowledgment: { method: "TYPED_NAME", typed_name: releasing, acknowledged_at: acknowledged },
        receiving_acknowledgment: { method: "TYPED_NAME", typed_name: receiving, acknowledged_at: acknowledged },
      },
    };
    setPhase("saving");
    setMessage("");
    try {
      const result = await submit(body);
      setPhase("saved");
      setMessage(`Server recorded transfer ${result.event.id}, sequence ${result.event.seq}, at ${formatWhen(result.event.recorded_at)}. Typed names were stored. A signature image was not stored.`);
      key.current = newRequestKey();
    } catch (error) {
      setPhase("failed");
      setMessage(errorText(error));
    }
  }
  return (
    <form className="m-stack" onSubmit={onSubmit}>
      <h3>Transfer</h3>
      <p className="m-muted">Both parties acknowledge with a typed name. This does not upload a signature.</p>
      <div className="m-filters">
        <label>Leg<select name="leg_id" defaultValue={legs[0]?.id}>{legs.map((leg) => <option key={leg.id} value={leg.id}>{leg.seq}</option>)}</select></label>
        <label>When<input name="occurred_at" type="datetime-local" required defaultValue={isoToLocalInput(new Date().toISOString())} /></label>
        <label>Releasing party<input name="releasing" required minLength={2} /></label>
        <label>Releasing organization<input name="releasing_org" /></label>
        <label>Receiving party<input name="receiving" required minLength={2} /></label>
        <label>Location name<input name="location" required /></label>
      </div>
      <button type="submit" disabled={phase === "saving"}>{phase === "saving" ? "Waiting for the server" : "Record transfer"}</button>
      <div aria-live="polite">
        {phase === "saving" && <p role="status">Waiting for the server. Nothing is recorded until the event returns.</p>}
        {phase === "failed" && <p role="alert">{message}</p>}
        {phase === "saved" && <p className="m-receipt" role="status">{message}</p>}
      </div>
    </form>
  );
}

export function CustodyHistory({ page }: { page: CustodyPage }) {
  return (
    <section className="m-panel">
      <h2>Recorded custody</h2>
      <p className="m-muted">Current custodian: {page.current_custodian ? `${page.current_custodian.name} (${page.current_custodian.kind})` : "None yet"}{page.chain_valid === true ? " · Chain checks out" : page.chain_valid === false ? " · Chain check failed" : ""}</p>
      {page.events.length === 0 ? <p>No custody events are on this case yet.</p> : (
        <ul className="m-list">{page.events.map((event) => <li key={event.id}>Seq {event.seq} · {human(event.kind)} · {formatWhen(event.recorded_at)} · {event.id}</li>)}</ul>
      )}
    </section>
  );
}

export function DocumentChecklist({ checklist, canReview }: { checklist: Checklist; canReview: boolean }) {
  const missing = checklist.items.filter((item) => item.state !== "APPROVED");
  return (
    <div className="m-stack">
      <p className="m-banner">{checklist.notice}</p>
      {!canReview && <p className="m-muted">File download and review need restricted access. Category and status stay visible for the checklist.</p>}
      {checklist.items.length === 0 ? <EmptyBlock title="No configured items" body="An empty checklist is not marked complete by this screen." /> : missing.length > 0 && (
        <p className="m-alert" role="status">{missing.length} configured item{missing.length === 1 ? "" : "s"} still not approved.</p>
      )}
      <ul className="m-list">
        {checklist.items.map((item) => (
          <li key={item.category}><strong>{human(item.category)}</strong> · {human(item.state)} · {item.sources.join(", ")}</li>
        ))}
      </ul>
      <p className={checklist.complete ? "m-ok" : "m-warn"}>{checklist.complete ? "Documents complete. Every configured checklist item is approved." : "Documents are not complete."}</p>
    </div>
  );
}

export function InternationalPanel({
  checklistComplete, view, canApprove, onApprove,
}: {
  checklistComplete: boolean;
  view: InternationalView;
  canApprove: boolean;
  onApprove: (body: { expected_version: number; acknowledge: string; note?: string }) => Promise<{ release_status: string; legal_clearance: boolean; approved_at?: string | null }>;
}) {
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [message, setMessage] = useState("");
  const [recorded, setRecorded] = useState<{ release_status: string; legal_clearance: boolean } | null>(null);
  const record = view.record;
  const releaseStatus = recorded?.release_status ?? record?.release_status;
  const cleared = releaseStatus === "APPROVED";
  const legalClearance = recorded?.legal_clearance ?? view.legal_clearance;
  async function approve() {
    if (!record || phase === "saving") return;
    if (!agreed) {
      setPhase("failed");
      setMessage("Check the acknowledgement before sending. Nothing was sent.");
      return;
    }
    setPhase("saving");
    setMessage("Waiting for the server. Clearance is unchanged until the record returns.");
    try {
      const result = await onApprove({ expected_version: record.version, acknowledge: RELEASE_ACKNOWLEDGEMENT, note: "Recorded from the mortuary workspace" });
      setRecorded({ release_status: result.release_status, legal_clearance: result.legal_clearance });
      setPhase("saved");
      setMessage(`Server recorded staff release. Status ${result.release_status}. ${result.legal_clearance ? "The server marked legal clearance." : "Not legal clearance."} ${result.approved_at ? formatWhen(result.approved_at) : ""}`);
    } catch (error) {
      setPhase("failed");
      setMessage(errorText(error));
    }
  }
  return (
    <div className="m-stack">
      <div className="m-split">
        <section className="m-panel" aria-label="Documents complete">
          <h2>Documents complete</h2>
          <p className={checklistComplete ? "m-ok" : "m-warn"}>{checklistComplete ? "Documents complete. Every configured checklist item is approved." : "Documents are not complete. A configured item is still missing or not approved."}</p>
        </section>
        <section className="m-panel" aria-label="Cleared for transport">
          <h2>Cleared for transport</h2>
          <p className={cleared ? "m-ok" : "m-warn"}>{cleared ? "Cleared for transport. Staff release approval is on the record." : "Not cleared for transport. Document status does not grant clearance."}</p>
          <p>{legalClearance ? "The server marked legal clearance." : "Not legal clearance. Staff release is an internal decision."}</p>
        </section>
      </div>
      {!record ? <EmptyBlock title="No international record" body="The case has no international coordination record yet." /> : (
        <section className="m-panel">
          <h2>Route</h2>
          <p>{record.origin_country} → {record.transit_countries.join(" → ")}{record.transit_countries.length ? " → " : ""}{record.destination_country}</p>
          <p>Receiving partner: {record.receiving_party ? `${record.receiving_party.name}${record.receiving_party.organization ? `, ${record.receiving_party.organization}` : ""}` : "Not recorded"}</p>
          <p>Carrier: {record.carrier ? `${record.carrier.name}${record.carrier.booking_reference ? ` · ${record.carrier.booking_reference}` : ""}` : "Not recorded"}</p>
          <h3>Requirements</h3>
          <ul className="m-list">{view.requirements.map((item) => <li key={item.id}>{item.country} · {item.authority} · {item.status}{item.stale ? " · stale" : ""} · reviewed {item.reviewed_on}</li>)}</ul>
          <h3>Milestones</h3>
          <ul className="m-list">{view.milestones.map((item) => <li key={item.id}>{human(item.kind)} · {formatWhen(item.occurred_at)}{item.reference ? ` · ${item.reference}` : ""}</li>)}</ul>
          {view.readiness.problems.length > 0 && <p className="m-alert" role="status">{view.readiness.problems.join(" ")}</p>}
          {canApprove && record.release_status !== "APPROVED" && (
            <div className="m-stack">
              <label className="m-check"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /> {RELEASE_ACKNOWLEDGEMENT}</label>
              <button type="button" disabled={phase === "saving"} onClick={() => void approve()}>{phase === "saving" ? "Waiting for the server" : "Approve release"}</button>
            </div>
          )}
          {!canApprove && <p className="m-muted">Owners record staff release.</p>}
          <div aria-live="polite">
            {phase === "failed" && <p role="alert">{message}</p>}
            {phase !== "failed" && message && <p className="m-receipt" role="status">{message}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

export function BillingPreview({ quotes, invoices, organization }: { quotes: Quote[]; invoices: Invoice[]; organization: string }) {
  const quote = quotes.find((item) => item.status === "ISSUED" || item.status === "ACCEPTED") ?? quotes[0];
  return (
    <div className="m-stack">
      {!quote ? <EmptyBlock title="No quote" body="Draft and issued quotes from the API will show here. This screen does not send a quote or take payment." /> : (
        <article className="m-paper" aria-label="Client-facing quote preview">
          <img src="/brand/thompson-emblem.jpg" alt="Thompson's Mortuary Services" width={180} height={100} />
          <p>Family owned since 2008</p>
          <p>Thompson&apos;s Mortuary Services</p>
          <p><a href="tel:4047350202">404-735-0202</a></p>
          <p className="m-warn">Preview only. This quote has not been sent.</p>
          <p>{organization}</p>
          <p>Quote {quote.number} · {human(quote.status)} · valid until {quote.valid_until}</p>
          <table>
            <tbody>
              {quote.lines.map((line) => <tr key={line.description}><td>{line.description}</td><td>{formatMoney(line.amount_cents)}</td></tr>)}
              <tr><th>Total</th><td>{formatMoney(quote.subtotal_cents)}</td></tr>
            </tbody>
          </table>
        </article>
      )}
      {invoices.map((invoice) => (
        <p key={invoice.id} className="m-panel">{invoice.invoice_number} · {human(invoice.status)} · {formatMoney(invoice.subtotal_cents)} · Payment {invoice.payment.status}. {invoice.payment.notice}</p>
      ))}
      {invoices.length === 0 && <p className="m-muted">No invoice. Payment collection is not connected.</p>}
    </div>
  );
}

export function CaseSections({
  detail, tab, onTab, role, client, onChanged,
}: {
  detail: CaseDetail;
  tab: string;
  onTab: (tab: string) => void;
  role: Role;
  client: MortuaryClient;
  onChanged: () => void;
}) {
  const tabs = ["overview", "legs", "dispatch", "custody", "documents", "quote", "activity", ...(detail.case.international ? ["international"] : [])];
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    onTab(tabs[next] ?? tabs[0]);
  }
  return (
    <div className="m-stack">
      <header>
        <h1>{detail.case.case_number}</h1>
        <p className="m-muted">{human(detail.case.status)} · {human(detail.case.service_type)} · {detail.case.requesting_organization.name}</p>
      </header>
      <div className="m-tabs" role="tablist" aria-label="Case sections" onKeyDown={onKey}>
        {tabs.map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => onTab(id)}>{human(id)}</button>)}
      </div>
      {tab === "overview" && <Overview detail={detail} role={role} client={client} />}
      {tab === "legs" && <Legs caseId={detail.case.id} client={client} />}
      {tab === "dispatch" && <p className="m-muted">Assignments are on the dispatch board. This case has {detail.summary.legs.total} leg{detail.summary.legs.total === 1 ? "" : "s"}.</p>}
      {tab === "custody" && <CustodyCase caseId={detail.case.id} client={client} onChanged={onChanged} />}
      {tab === "documents" && <DocumentsCase caseId={detail.case.id} client={client} canReview={role === "OWNER" || detail.case.restricted_access} />}
      {tab === "quote" && <BillingCase caseId={detail.case.id} organization={detail.case.requesting_organization.name} client={client} />}
      {tab === "international" && <InternationalCase caseId={detail.case.id} client={client} canApprove={role === "OWNER"} onChanged={onChanged} />}
      {tab === "activity" && <ActivityCase caseId={detail.case.id} client={client} />}
    </div>
  );
}

function Overview({ detail, role, client }: { detail: CaseDetail; role: Role; client: MortuaryClient }) {
  const [restricted, setRestricted] = useState<string | null>(null);
  const [error, setError] = useState("");
  const item = detail.case;
  return (
    <div className="m-panel m-stack">
      <p>Origin {placeLine(item.origin)}</p>
      <p>Destination {placeLine(item.destination)}</p>
      <p>Coordinator {item.coordinator_member_id ? "Assigned" : "Unassigned"}</p>
      <p>CRM {item.crm_system ? `${item.crm_system} ${item.crm_account_ref ?? ""}` : "No CRM reference"}</p>
      <p>Mail threads {item.mail_thread_refs.length ? item.mail_thread_refs.join(", ") : "None"}</p>
      <p className="m-muted">These references are opaque. This screen does not write to CRM or Mail.</p>
      {role !== "DRIVER" && item.restricted_access && item.has_restricted_record && (
        <button type="button" onClick={() => void client.restricted(item.id).then((record) => setRestricted(record.decedent_full_name), (reason: unknown) => setError(errorText(reason)))}>Show restricted record</button>
      )}
      {restricted && <p className="m-restricted">Restricted record: {restricted}</p>}
      {error && <p role="alert">{error}</p>}
      {!item.restricted_access && <p className="m-muted">Restricted case detail is hidden for this session.</p>}
    </div>
  );
}

function Legs({ caseId, client }: { caseId: string; client: MortuaryClient }) {
  const [legs, setLegs] = useState<Leg[] | null>(null);
  const [error, setError] = useState("");
  if (!legs && !error) void client.listLegs(caseId).then(setLegs, (reason: unknown) => setError(errorText(reason)));
  if (error) return <ErrorBlock message={error} />;
  if (!legs) return <LoadingBlock label="Loading legs" />;
  return <ul className="m-list">{legs.map((leg) => <li key={leg.id}>{leg.seq} · {human(leg.status)} · {placeLine(leg.from)} → {placeLine(leg.to)} · {formatWhen(leg.scheduled_departure_at)}</li>)}</ul>;
}

function CustodyCase({ caseId, client, onChanged }: { caseId: string; client: MortuaryClient; onChanged: () => void }) {
  const [page, setPage] = useState<CustodyPage | null>(null);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [error, setError] = useState("");
  if (!page && !error) {
    void Promise.all([client.custody(caseId), client.listLegs(caseId)]).then(([custody, found]) => { setPage(custody); setLegs(found); }, (reason: unknown) => setError(errorText(reason)));
  }
  if (error) return <ErrorBlock message={error} />;
  if (!page) return <LoadingBlock label="Loading custody" />;
  const expected = page.events.at(-1)?.seq ?? 0;
  return (
    <div className="m-stack">
      <CustodyHistory page={page} />
      <section className="m-panel"><h2>Identity check</h2><CustodyForm legs={legs} expectedSeq={expected} submit={async (body) => { const result = await client.recordCustody(caseId, body); onChanged(); return result; }} /></section>
      <section className="m-panel"><TransferForm legs={legs} expectedSeq={expected} submit={async (body) => { const result = await client.recordCustody(caseId, body); onChanged(); return result; }} /></section>
    </div>
  );
}

function DocumentsCase({ caseId, client, canReview }: { caseId: string; client: MortuaryClient; canReview: boolean }) {
  return <DocumentWorkspace caseId={caseId} client={client} canReview={canReview} />;
}

function BillingCase({ caseId, organization, client }: { caseId: string; organization: string; client: MortuaryClient }) {
  const [data, setData] = useState<{ quotes: Quote[]; invoices: Invoice[] } | null>(null);
  const [error, setError] = useState("");
  if (!data && !error) void client.billing(caseId).then(setData, (reason: unknown) => setError(errorText(reason)));
  if (error) return <ErrorBlock message={error} />;
  if (!data) return <LoadingBlock label="Loading billing" />;
  return <BillingPreview quotes={data.quotes} invoices={data.invoices} organization={organization} />;
}

function InternationalCase({ caseId, client, canApprove, onChanged }: { caseId: string; client: MortuaryClient; canApprove: boolean; onChanged: () => void }) {
  const [view, setView] = useState<InternationalView | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [error, setError] = useState("");
  if ((!view || !checklist) && !error) {
    void Promise.all([client.international(caseId), client.checklist(caseId)]).then(([next, list]) => { setView(next); setChecklist(list); }, (reason: unknown) => setError(errorText(reason)));
  }
  if (error) return <ErrorBlock message={error} />;
  if (!view || !checklist) return <LoadingBlock label="Loading international coordination" />;
  return (
    <InternationalPanel
      checklistComplete={checklist.complete}
      view={view}
      canApprove={canApprove}
      onApprove={async (body) => {
        const result = await client.approveRelease(caseId, body);
        onChanged();
        return { release_status: result.record?.release_status ?? "NOT_REQUESTED", legal_clearance: result.legal_clearance, approved_at: result.record?.release_approved_at };
      }}
    />
  );
}

function ActivityCase({ caseId, client }: { caseId: string; client: MortuaryClient }) {
  const [rows, setRows] = useState<{ history: { id: string; to_status: string; created_at: string; actor: { role?: string | null } }[]; events: { id: string; target: string; kind: string; status: string }[] } | null>(null);
  const [error, setError] = useState("");
  if (!rows && !error) {
    void Promise.all([client.history(caseId), client.integrationEvents(caseId)]).then(([history, events]) => setRows({ history, events }), (reason: unknown) => setError(errorText(reason)));
  }
  if (error) return <ErrorBlock message={error} />;
  if (!rows) return <LoadingBlock label="Loading activity" />;
  return (
    <div className="m-stack">
      <section className="m-panel"><h2>Status history</h2><ul className="m-list">{rows.history.map((row) => <li key={row.id}>{formatWhen(row.created_at)} · {human(row.to_status)} · {row.actor.role ?? "actor"}</li>)}</ul></section>
      <section className="m-panel">
        <h2>Integration outbox</h2>
        <p className="m-muted">Events stay pending until a consumer exists. Nothing is sent to CRM, Mail, or Signal from this screen.</p>
        {rows.events.length === 0 ? <p>No outbox events.</p> : <ul className="m-list">{rows.events.map((event) => <li key={event.id}>{event.target} · {event.kind} · {event.status}</li>)}</ul>}
      </section>
    </div>
  );
}
