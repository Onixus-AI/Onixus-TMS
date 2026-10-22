import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorText, type MortuaryClient } from "./client";
import { newRequestKey, localInputToIso } from "./format";
import type { CaseDetail, Leg, Quote, Invoice, Role } from "./types";
import { BillingPreview, ErrorBlock, human, LoadingBlock } from "./ui";

type Fields = Record<string, string>;
export function ActionForm({ title, children, save, onSaved }: { title: string; children: ReactNode; save: (fields: Fields, key: string) => Promise<unknown>; onSaved?: () => void }) {
  const attempt = useRef<{ fields: Fields; key: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "saving" | "failed" | "saved">("idle");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "saving" || phase === "saved") return;
    if (!attempt.current) attempt.current = { fields: Object.fromEntries(new FormData(event.currentTarget).entries()) as Fields, key: newRequestKey() };
    setPhase("saving"); setMessage("");
    try {
      await save(attempt.current.fields, attempt.current.key);
      setPhase("saved"); setMessage("Server confirmed this action."); onSaved?.();
    } catch (error) { setPhase("failed"); setMessage(errorText(error)); }
  }
  return <form className="m-panel m-stack" onSubmit={submit}><h3>{title}</h3>
    <fieldset disabled={phase !== "idle"}>{children}</fieldset>
    <button type="submit" disabled={phase === "saving" || phase === "saved"}>{phase === "saving" ? "Waiting for server…" : phase === "failed" ? "Retry same action" : title}</button>
    {phase === "failed" && <p className="m-muted">The original values are retained for a safe retry. Refresh the case before changing a conflicting version.</p>}
    {message && <p role={phase === "failed" ? "alert" : "status"}>{message}</p>}
  </form>;
}
function Text({ name, label, value, type = "text", required = true }: { name: string; label: string; value?: string; type?: string; required?: boolean }) {
  return <label>{label}<input name={name} type={type} step={type === "number" ? "any" : undefined} defaultValue={value} required={required} maxLength={500} /></label>;
}
function Select({ name, label, options }: { name: string; label: string; options: string[] }) {
  return <label>{label}<select name={name}>{options.map(value => <option key={value} value={value}>{human(value)}</option>)}</select></label>;
}
function dateTime(value: string) { const iso = localInputToIso(value); if (!iso) throw new Error("Enter a valid date and time."); return iso; }
export function CaseActions({ detail, client, onSaved }: { detail: CaseDetail; client: MortuaryClient; onSaved: () => void }) {
  const c = detail.case;
  const transitions: Record<string, string[]> = { INTAKE: ["AWAITING_RELEASE", "ON_HOLD", "CANCELED"], AWAITING_RELEASE: ["READY_FOR_DISPATCH", "ON_HOLD", "CANCELED"], READY_FOR_DISPATCH: ["IN_TRANSIT", "AWAITING_RELEASE", "ON_HOLD", "CANCELED"], IN_TRANSIT: ["DELIVERED", "ON_HOLD"], DELIVERED: ["CLOSED"], ON_HOLD: [c.held_from_status || "AWAITING_RELEASE", "CANCELED"] };
  return <div className="m-stack">
    {(transitions[c.status] ?? []).length > 0 && <ActionForm key={`transition-${c.version}`} title="Update case status" onSaved={onSaved} save={(f, key) => client.action(c.id, "transitions", { expected_version: c.version, request_key: key, to: f.to, ...(f.reason ? { reason: f.reason } : {}) })}>
      <Select name="to" label="Next status" options={transitions[c.status]!}/><Text name="reason" label="Reason (required for hold, cancellation or returning to release)" required={false}/>
      <p className="m-muted">The server checks documents, custody, onboarding and release requirements before accepting a transition.</p>
    </ActionForm>}
    {!["DELIVERED", "CLOSED", "CANCELED"].includes(c.status) && <ActionForm key={`edit-${c.version}`} title="Save case details" onSaved={onSaved} save={(f) => client.action(c.id, "", { expected_version: c.version, requesting_organization: { ...c.requesting_organization, name: f.organization }, origin: { ...c.origin, name: f.origin, address_line: f.origin_address }, destination: { ...c.destination, name: f.destination, address_line: f.destination_address } }, "PATCH")}>
      <Text name="organization" label="Requesting organization" value={c.requesting_organization.name}/>
      <Text name="origin" label="Origin facility" value={c.origin.name}/><Text name="origin_address" label="Origin address" value={c.origin.address_line ?? ""} required={false}/>
      <Text name="destination" label="Destination facility" value={c.destination.name}/><Text name="destination_address" label="Destination address" value={c.destination.address_line ?? ""} required={false}/>
    </ActionForm>}
  </div>;
}

export function LegWorkspace({ caseId, client }: { caseId: string; client: MortuaryClient }) {
  const [legs, setLegs] = useState<Leg[] | null>(null);
  const [error, setError] = useState(""); const [tick, setTick] = useState(0);
  useEffect(() => { let active = true; client.listLegs(caseId).then(result => { if (active) { setLegs(result); setError(""); } }, e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [client, caseId, tick]);
  const reload = () => setTick(n => n + 1);
  if (!legs) return error ? <ErrorBlock message={error} onRetry={reload}/> : <LoadingBlock label="Loading transport legs"/>;
  return <div className="m-stack">{error && <ErrorBlock message={error}/>}
    {legs.map(leg => <section className="m-panel m-stack" key={`${leg.id}-${leg.version}`}><h3>Leg {leg.seq} · {human(leg.status)}</h3><p>{leg.from.name} → {leg.to.name}</p>
      {["PLANNED", "ASSIGNED"].includes(leg.status) && <ActionForm title="Reschedule leg" onSaved={reload} save={f => client.action(caseId, `legs/${leg.id}`, { expected_version: leg.version, scheduled_departure_at: dateTime(f.departure!), scheduled_arrival_at: dateTime(f.arrival!) }, "PATCH")}><Text name="departure" label="Departure" type="datetime-local"/><Text name="arrival" label="Arrival" type="datetime-local"/></ActionForm>}
      {leg.mode !== "GROUND" && ["PLANNED", "ASSIGNED"].includes(leg.status) && <ActionForm title="Assign carrier or partner" onSaved={reload} save={f => client.action(caseId, `legs/${leg.id}/assignment`, { expected_version: leg.version, carrier: { name: f.carrier } })}><Text name="carrier" label="Carrier or partner name" value={leg.carrier?.name}/></ActionForm>}
      {leg.status === "ASSIGNED" && <ActionForm title="Remove assignment" onSaved={reload} save={() => client.action(caseId, `legs/${leg.id}/unassign`, { expected_version: leg.version })}><p>This returns the leg to planning.</p></ActionForm>}
      {!["DELIVERED", "CANCELED"].includes(leg.status) && <ActionForm title="Update leg status" onSaved={reload} save={f => client.action(caseId, `legs/${leg.id}/status`, { expected_version: leg.version, to: f.to, ...(f.reason ? { reason: f.reason } : {}) })}><Select name="to" label="Leg status" options={leg.status === "IN_CUSTODY" ? ["DELIVERED"] : leg.status === "EN_ROUTE" ? ["IN_CUSTODY", "CANCELED"] : leg.status === "ASSIGNED" ? ["EN_ROUTE", "CANCELED"] : ["CANCELED"]}/><Text name="reason" label="Cancellation reason" required={false}/></ActionForm>}
    </section>)}
    <ActionForm key={`create-${legs.length}`} title="Create transport leg" onSaved={reload} save={(f,key) => client.action(caseId, "legs", { request_key: key, mode: f.mode, from: { name: f.origin, facility_type: "OTHER", country: f.origin_country?.toUpperCase() }, to: { name: f.destination, facility_type: "OTHER", country: f.destination_country?.toUpperCase() }, scheduled_departure_at: dateTime(f.departure!), scheduled_arrival_at: dateTime(f.arrival!) })}>
      <Select name="mode" label="Transport mode" options={["GROUND", "AIR", "PARTNER"]}/><Text name="origin" label="Pickup facility"/><Text name="origin_country" label="Pickup country code" value="US"/><Text name="destination" label="Destination facility"/><Text name="destination_country" label="Destination country code" value="US"/><Text name="departure" label="Scheduled departure" type="datetime-local"/><Text name="arrival" label="Scheduled arrival" type="datetime-local"/>
    </ActionForm>
  </div>;
}

export function BillingWorkspace({ caseId, organization, client, role }: { caseId: string; organization: string; client: MortuaryClient; role: Role }) {
  const [data, setData] = useState<{ quotes: Quote[]; invoices: Invoice[] } | null>(null);
  const [error, setError] = useState(""); const [tick, setTick] = useState(0);
  useEffect(() => { let active = true; client.billing(caseId).then(result => { if (active) { setData(result); setError(""); } }, e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [client, caseId, tick]);
  const reload = () => setTick(n => n + 1);
  if (!data) return error ? <ErrorBlock message={error} onRetry={reload}/> : <LoadingBlock label="Loading billing"/>;
  const today = new Date().toISOString().slice(0,10);
  return <div className="m-stack"><BillingPreview {...data} organization={organization}/>{error && <ErrorBlock message={error}/>}
    <p className="m-banner">Issuing an invoice does not send it or collect payment. Payment requires a verified provider receipt.</p>
    <ActionForm key={`quote-${data.quotes.length}`} title="Draft quote" onSaved={reload} save={(f,key) => {
      const lines = [
        { category: "SERVICE", description: f.description, quantity: 1, unit_cents: Math.round(Number(f.service) * 100) },
        ...(Number(f.miles) > 0 ? [{ category: "MILEAGE", description: "Transport mileage", quantity: Number(f.miles), unit_cents: Math.round(Number(f.rate) * 100) }] : []),
        ...(Number(f.additional) > 0 ? [{ category: "ADDITIONAL", description: f.additional_description, quantity: 1, unit_cents: Math.round(Number(f.additional) * 100) }] : [])
      ];
      return client.action(caseId, "quotes", { request_key: key, lines, valid_until: f.valid_until });
    }}><Text name="description" label="Service description"/><Text name="service" label="Service price (USD)" type="number"/><Text name="miles" label="Mileage quantity" type="number" required={false}/><Text name="rate" label="Price per mile (USD)" type="number" required={false}/><Text name="additional" label="Additional charge (USD)" type="number" required={false}/><Text name="additional_description" label="Additional charge description" required={false}/><Text name="valid_until" label="Valid until" type="date" value={today}/></ActionForm>
    {role === "OWNER" && data.quotes.map(quote => <div key={`${quote.id}-${quote.version}`} className="m-stack">
      {quote.status === "DRAFT" && <ActionForm title={`Edit draft ${quote.number}`} onSaved={reload} save={f => client.action(caseId, `quotes/${quote.id}`, { expected_version: quote.version, valid_until: f.valid_until, lines: quote.lines.map((line,index) => ({ category: line.category, description: f[`description_${index}`], quantity: Number(f[`quantity_${index}`]), unit_cents: Math.round(Number(f[`price_${index}`]) * 100) })) }, "PATCH")}>
        {quote.lines.map((line,index) => <div key={index}><Text name={`description_${index}`} label={`Line ${index+1} description`} value={line.description}/><Text name={`quantity_${index}`} label={`Line ${index+1} quantity`} type="number" value={String(line.quantity)}/><Text name={`price_${index}`} label={`Line ${index+1} unit price (USD)`} type="number" value={String(line.unit_cents/100)}/></div>)}<Text name="valid_until" label="Quote expiry" type="date" value={quote.valid_until}/>
      </ActionForm>}
      {quote.status === "DRAFT" && <ActionForm title={`Issue quote ${quote.number}`} onSaved={reload} save={() => client.action(caseId, `quotes/${quote.id}/issue`, { expected_version: quote.version })}><p>Freeze this quote for customer review.</p></ActionForm>}
      {quote.status === "ISSUED" && <><ActionForm title={`Record acceptance of ${quote.number}`} onSaved={reload} save={f => client.action(caseId, `quotes/${quote.id}/accept`, { expected_version: quote.version, acceptance_reference: f.reference })}><Text name="reference" label="Customer acceptance reference"/></ActionForm><ActionForm title={`Decline quote ${quote.number}`} onSaved={reload} save={f => client.action(caseId, `quotes/${quote.id}/decline`, { expected_version: quote.version, reason: f.reason })}><Text name="reason" label="Decline reason"/></ActionForm></>}
      {quote.status === "ACCEPTED" && !data.invoices.some(i => i.quote_id === quote.id && i.status !== "VOID") && <ActionForm title={`Issue invoice for ${quote.number}`} onSaved={reload} save={(f,key) => client.action(caseId, "invoices", { request_key: key, quote_id: quote.id, due_date: f.due_date })}><Text name="due_date" label="Invoice due date" type="date" value={today}/></ActionForm>}
    </div>)}
    {role === "OWNER" && data.invoices.filter(i => i.status === "ISSUED").map(invoice => <ActionForm key={`${invoice.id}-${invoice.version}`} title={`Void invoice ${invoice.invoice_number}`} onSaved={reload} save={f => client.action(caseId, `invoices/${invoice.id}/void`, { expected_version: invoice.version, reason: f.reason })}><Text name="reason" label="Reason for voiding"/></ActionForm>)}
  </div>;
}

export function RestrictedEditor({ detail, client, onSaved }: { detail: CaseDetail; client: MortuaryClient; onSaved: () => void }) {
  const [record, setRecord] = useState<Awaited<ReturnType<MortuaryClient["restricted"]>> | null>(null);
  const [opened, setOpened] = useState(false); const [error, setError] = useState("");
  if (!detail.case.restricted_access) return null;
  if (!opened) return <button type="button" onClick={() => { if (!detail.case.has_restricted_record) setOpened(true); else void client.restricted(detail.case.id).then(r => { setRecord(r); setOpened(true); }, e => setError(errorText(e))); }}>Edit restricted record{error && `: ${error}`}</button>;
  return <ActionForm title="Save restricted record" onSaved={onSaved} save={f => client.action(detail.case.id, "restricted", { expected_version: record?.version ?? 0, decedent_full_name: f.decedent_full_name, ...Object.fromEntries(Object.entries(f).filter(([k,v]) => k !== "decedent_full_name" && v)) }, "PUT")}>
    <p className="m-banner">Restricted information stays in the case system. Access is audit logged.</p>
    <Text name="decedent_full_name" label="Decedent full name" value={record?.decedent_full_name}/>
    {([['date_of_birth','Date of birth','date'],['date_of_death','Date of death','date'],['place_of_death','Place of death','text'],['id_tag_number','Identification tag','text'],['handling_notes','Handling notes','text'],['precautions','Precautions','text'],['personal_effects','Personal effects','text'],['religious_or_cultural_considerations','Religious or cultural considerations','text']] as const).map(([name,label,type]) => <Text key={name} name={name} label={label} type={type} value={String((record as unknown as Record<string, unknown> | null)?.[name] ?? '')} required={false}/>)}
  </ActionForm>;
}
