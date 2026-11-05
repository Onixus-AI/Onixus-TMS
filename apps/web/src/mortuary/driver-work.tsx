import { useEffect, useState } from "react";
import type { MortuaryClient } from "./client";
import { errorText } from "./client";
import { ActionForm } from "./actions";
import { CustodyForm, TransferForm, ErrorBlock } from "./ui";
import type { BoardLeg, CustodyPage } from "./types";

export function DriverLegWorkspace({ leg, client, onChanged }: { leg: BoardLeg; client: MortuaryClient; onChanged: () => void }) {
  const [page, setPage] = useState<CustodyPage | null>(null);
  const [error, setError] = useState(""); const [tick, setTick] = useState(0);
  useEffect(() => { let active = true; client.driverCustody(leg.id).then(value => { if (active) { setPage(value); setError(""); } }, e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [leg.id, client, tick]);
  const next = leg.status === "ASSIGNED" ? "EN_ROUTE" : leg.status === "EN_ROUTE" ? "IN_CUSTODY" : leg.status === "IN_CUSTODY" ? "DELIVERED" : null;
  const refresh = () => { setTick(n => n + 1); onChanged(); };
  const submit: Parameters<typeof CustodyForm>[0]["submit"] = async body => { const result = await client.driverRecordCustody(leg.id, body); refresh(); return result; };
  return <article className="m-panel m-stack"><h2>{leg.case_number} · {leg.status}</h2><p>{leg.from.name} → {leg.to.name}</p>
    <p>{new Date(leg.scheduled_departure_at).toLocaleString()}</p>
    {next && <ActionForm title={`Mark ${next.toLowerCase().replaceAll("_", " ")}`} onSaved={refresh} save={() => client.driverStatus(leg.id, { expected_version: leg.version, to: next })}><p>Custody requirements are checked by the server.</p></ActionForm>}
    {error && <ErrorBlock message={error} onRetry={refresh}/>}
    {page && typeof page.last_seq === "number" && <>
      <CustodyForm legs={[leg]} expectedSeq={page.last_seq} submit={submit}/>
      <TransferForm legs={[leg]} expectedSeq={page.last_seq} submit={submit}/>
      <ul>{page.events.map(e => <li key={e.id}>#{e.seq} · {e.kind} · {new Date(e.recorded_at).toLocaleString()}</li>)}</ul>
    </>}
    {page && typeof page.last_seq !== "number" && <p role="alert">This API does not yet support safe driver custody updates. Contact dispatch.</p>}
  </article>;
}
