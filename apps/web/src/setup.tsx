import { useState, type FormEvent } from "react";
import { OTR_EQUIPMENT, OTR_EQUIPMENT_LABELS, TRANSPORT_MODULES, type OtrEquipment, type TransportType } from "@onixus/core";
import { api } from "./api";
import { ConnectionsPage } from "./connections";
import { Field, Problem, useAction } from "./trucking";

// Company setup, full screen (no sidebar): what the company does, then connect everything. The app
// opens here until the owner finishes; afterwards it is reachable from Operations → Edit setup.

type Setup = { modules: string[]; equipment: string[]; service_area?: string; timezone?: string };
const WORKSPACE = "https://veltra-model-1.vercel.app";

export function SetupFlow({ initial, onDone, onCancel }: { initial: Setup; onDone: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [modules, setModules] = useState<string[]>(initial.modules);
  const [equipment, setEquipment] = useState<string[]>(initial.equipment);
  const [area, setArea] = useState(initial.service_area ?? "");
  const [timezone, setTimezone] = useState(initial.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/New_York");
  const a = useAction(() => {});
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const otr = modules.includes("TRUCKING");
  const ready = modules.length > 0 && (!otr || equipment.length > 0);
  const save = (complete: boolean) => api("/transport/profile", { method: "PUT", body: { modules, equipment: otr ? equipment : [], service_area: area, timezone, complete } });

  const next = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => { await save(false); setStep(2); window.scrollTo({ top: 0 }); });
  };
  const finish = () => void a.run(async () => { await save(true); onDone(); });

  return (
    <div className="setup">
      <ol className="setup-steps" aria-label="Setup steps">
        <li className={step === 1 ? "active" : "done"}>1. Your services</li>
        <li className={step === 2 ? "active" : ""}>2. Connect everything</li>
      </ol>

      {step === 1 && (
        <form className="stack" onSubmit={next}>
          <div>
            <h1>What does your company do?</h1>
            <p className="muted">Choose every service you run. Onixus TMS shows only what fits: drayage gets containers and terminals, OTR gets your equipment and lanes.</p>
          </div>
          <div className="transport-modules">
            {TRANSPORT_MODULES.map((m) => (
              <label className={`transport-module ${modules.includes(m.id) ? "selected" : ""}`} key={m.id}>
                <span><input type="checkbox" checked={modules.includes(m.id)} onChange={() => toggle(modules, setModules, m.id as TransportType)} /><strong>{m.name}</strong></span>
                <small>{m.ready}</small>
              </label>
            ))}
          </div>
          {otr && (
            <fieldset className="card stack equipment-picker">
              <legend>OTR: which equipment do you run?</legend>
              <div className="chips">
                {OTR_EQUIPMENT.map((id: OtrEquipment) => (
                  <label key={id} className={`chip ${equipment.includes(id) ? "on" : ""}`}>
                    <input type="checkbox" checked={equipment.includes(id)} onChange={() => toggle(equipment, setEquipment, id)} />
                    {OTR_EQUIPMENT_LABELS[id]}
                  </label>
                ))}
              </div>
              {!equipment.length && <small className="muted">Choose at least one.</small>}
            </fieldset>
          )}
          <div className="fields">
            <Field label="Where you run"><input value={area} onChange={(e) => setArea(e.target.value)} maxLength={1000} placeholder="e.g. Southeast, nationwide, or Norfolk and Savannah ports" /></Field>
            <Field label="Timezone"><input value={timezone} onChange={(e) => setTimezone(e.target.value)} required /></Field>
          </div>
          <Problem error={a.error} />
          <div className="actions">
            <button className="primary" disabled={a.busy || !ready}>{a.busy ? "Saving…" : "Continue"}</button>
            {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="stack">
          <div>
            <h1>Connect everything</h1>
            <p className="muted">Connect what you use now; you can add the rest later under Connections.</p>
          </div>
          <section className="card stack">
            <h2>Onixus Workspace: Mail and CRM</h2>
            <p className="muted">Mail answers rate requests with your rates, follows up and keeps the inbox clean. CRM keeps your customers and brokers. Both live in your Onixus Workspace.</p>
            <div className="actions">
              <a className="button" href={`${WORKSPACE}/?canvas=mail`} target="_blank" rel="noreferrer">Connect Mail ↗</a>
              <a className="button" href={`${WORKSPACE}/?canvas=crm`} target="_blank" rel="noreferrer">Open CRM ↗</a>
            </div>
          </section>
          <ConnectionsPage owner />
          <Problem error={a.error} />
          <div className="actions setup-finish">
            <button type="button" onClick={() => setStep(1)}>Back</button>
            <button className="primary" disabled={a.busy} onClick={finish}>{a.busy ? "Finishing…" : "Finish setup"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
