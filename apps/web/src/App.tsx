import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api } from "./api";
import { arrivedFrom, authConfigured, supabase } from "./supabase";
import { ChoosePassword, Onboarding, SignIn, Team } from "./account";
import {Operations} from "./operations";
import { Billing } from "./billing";
import { ConnectionsPage } from "./connections";
import { DriverApp } from "./driver";
import { NavContext, type Intent, type Tab } from "./nav";
import { Overview } from "./overview";
import { Platform } from "./platform";
import { Containers, Customers, Dispatch, Fleet, Loads, Problem } from "./trucking";
import { OnixusLogo } from "./logo";
import { httpMortuaryClient } from "./mortuary/client";
import { DriverMortuary, MortuaryOffice, type MortuaryTab } from "./mortuary/office";
import type { QueueId } from "./mortuary/types";

export type Me = {
  user: { id: string; email: string };
  membership: { role: "OWNER" | "DISPATCHER" | "DRIVER"; driver_id: string | null } | null;
  organization: { name: string; kind: string } | null;
};

// Back from a provider's sign-in (Gmail, Outlook, QuickBooks): read once at load, then tidy the address bar.
const connectionReturn = (() => {
  const q = new URLSearchParams(window.location.search);
  const ok = q.get("connected"), err = q.get("connection_error");
  if (!ok && !err) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  return ok ? { ok: true, text: `Connected ${ok.replace(/^\w/, (c) => c.toUpperCase())}.` } : { ok: false, text: err! };
})();

const initials = (email: string) => email.split("@")[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";


function Account({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="account">
      <button className="avatar" aria-label="Account" aria-expanded={open} onClick={() => setOpen(!open)}>{initials(me.user.email)}</button>
      {open && (
        <div className="menu" role="menu">
          <div className="small">{me.user.email}</div>
          <div className="muted small">{me.organization?.name} · {me.membership?.role.toLowerCase()}</div>
          <button role="menuitem" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Shell({ me, children, tabs, tab, setTab, area, setArea }: { me: Me; children: React.ReactNode; tabs: [Tab, string][]; tab?: Tab; setTab?: (t: Tab) => void; area?: "freight" | "mortuary"; setArea?: (area: "freight" | "mortuary") => void }) {
  const [collapsed,setCollapsed]=useState(false);
  return (
    <div className={`shell tms-shell ${collapsed?"sidebar-collapsed":""}`}>
      <header className="topbar">
        <div className="brand">
          <OnixusLogo />
          <div>
            <strong>Onixus TMS</strong>
            <span className="org">{me.organization?.name ?? "Transport OS"}</span>
          </div>
        </div>
        <button aria-label="Toggle navigation" aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}>☰</button>
        <Account me={me} />
      </header>
      {!collapsed&&tabs.length>0&&<aside className="tms-sidebar">        {setArea && (
          <div className="area-switch" role="group" aria-label="Operational area">
            <button type="button" className={area === "freight" ? "active" : ""} aria-pressed={area === "freight"} onClick={() => setArea("freight")}>Freight</button>
            <button type="button" className={area === "mortuary" ? "active" : ""} aria-pressed={area === "mortuary"} onClick={() => setArea("mortuary")}>Mortuary</button>
          </div>
        )}
        {tabs.length > 0 && (
          <nav className="tms-navigation" aria-label="Sections">
            {tabs.map(([id, label]) => (
              <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab?.(id)}>{label}</button>
            ))}
          </nav>
        )}
<div className="tms-suite-links"><small>Business OS</small><a href="https://veltra-model-1.vercel.app/">Veltra Chat</a><a href="https://veltra-model-1.vercel.app/?canvas=mail">Veltra Mail</a><a href="https://veltra-model-1.vercel.app/?canvas=crm">Veltra CRM</a></div></aside>}
      <main>{children}</main>
    </div>
  );
}

function Office({ me }: { me: Me }) {
  const owner = me.membership?.role === "OWNER";
  const drives = Boolean(me.membership?.driver_id);
  // Owner-operators mostly drive: open on their trips.
  const returned = connectionReturn;
  const [area, setArea] = useState<"freight" | "mortuary">("freight");
  const [tab, setTab] = useState<Tab>(returned ? "connections" : me.organization?.kind === "OWNER_OPERATOR" && drives ? "mytrips" : "operations");
  const [intent, setIntent] = useState<Intent>({});
  const go = useCallback((t: Tab, i: Intent = {}) => {
    setIntent(i);
    setTab(t);
    window.scrollTo({ top: 0 });
  }, []);
  const chooseArea = (next: "freight" | "mortuary") => {
    setArea(next);
    setIntent({});
    setTab(next === "mortuary" ? "m-ops" : "operations");
  };
  const freightTabs: [Tab, string][] = [
    ["operations", "Operations"], ["overview", "Overview"],
    ...(drives ? ([["mytrips", "My trips"]] as [Tab, string][]) : []),
    ["loads", "Loads"], ["dispatch", "Dispatch"], ["containers", "Containers"], ["billing", "Billing"], ["fleet", "Fleet"], ["customers", "Customers"],
    ["connections", "Connections"],
    ...(owner ? ([["team", "Team"], ["platform", "Platform"]] as [Tab, string][]) : []),
  ];
  const mortuaryTabs: [Tab, string][] = [["m-ops", "Operations"], ["m-cases", "Cases"], ["m-dispatch", "Dispatch"], ["m-international", "International"]];
  const tabs = area === "mortuary" ? mortuaryTabs : freightTabs;
  const loadFleet = useCallback(async () => {
    const [drivers, trucks] = await Promise.all([
      api<{ drivers: { id: string; name?: string }[] }>("/drivers"),
      api<{ trucks: { id: string; truck_number?: string; name?: string }[] }>("/trucks"),
    ]);
    return {
      drivers: drivers.drivers.map((driver) => ({ id: driver.id, label: driver.name || driver.id })),
      vehicles: trucks.trucks.map((truck) => ({ id: truck.id, label: truck.truck_number || truck.name || truck.id })),
    };
  }, []);
  const mortuaryClient = useMemo(() => httpMortuaryClient(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }), []);
  const mortuaryTab: MortuaryTab = tab === "m-cases" ? "cases" : tab === "m-dispatch" ? "dispatch" : tab === "m-international" ? "international" : "operations";
  const queue = (intent.queue === "active" || intent.queue === "unassigned_pickups" || intent.queue === "upcoming_transfers" || intent.queue === "missing_documents" || intent.queue === "past_window" || intent.queue === "needs_approval") ? intent.queue as QueueId : null;
  return (
    <NavContext.Provider value={{ go, intent, clearIntent: () => setIntent({}) }}>
      <Shell me={me} tabs={tabs} tab={tab} setTab={(t) => go(t)} area={area} setArea={chooseArea}>
        {area === "mortuary" && (
          <MortuaryOffice
            role={me.membership?.role ?? "DISPATCHER"}
            client={mortuaryClient}
            loadFleet={loadFleet}
            tab={mortuaryTab}
            caseId={intent.caseId ?? null}
            queue={queue}
            onTab={(next) => go(next === "cases" ? "m-cases" : next === "dispatch" ? "m-dispatch" : next === "international" ? "m-international" : "m-ops", {})}
            onOpenCase={(id) => go("m-cases", { caseId: id })}
            onQueue={(next) => go("m-cases", next ? { queue: next } : {})}
          />
        )}
        {area === "freight" && tab === "operations" && <Operations owner={owner} />}
        {area === "freight" && tab === "overview" && <Overview me={me} />}
        {area === "freight" && tab === "mytrips" && <DriverApp />}
        {area === "freight" && tab === "loads" && <Loads />}
        {area === "freight" && tab === "dispatch" && <Dispatch />}
        {area === "freight" && tab === "containers" && <Containers />}
        {area === "freight" && tab === "billing" && <Billing owner={owner} />}
        {area === "freight" && tab === "fleet" && <Fleet />}
        {area === "freight" && tab === "customers" && <Customers />}
        {area === "freight" && tab === "team" && <Team />}
        {area === "freight" && tab === "connections" && <ConnectionsPage owner={owner} notice={returned} />}
        {area === "freight" && tab === "platform" && <Platform />}
      </Shell>
    </NavContext.Provider>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [needsPassword, setNeedsPassword] = useState(arrivedFrom === "invite" || arrivedFrom === "recovery");
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setNeedsPassword(true);
      if (event === "SIGNED_OUT") setMe(null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const loadMe = useCallback(() => {
    setError(null);
    api<Me>("/me").then(setMe, setError);
  }, []);
  useEffect(() => {
    if (session) loadMe();
  }, [session?.user.id, loadMe]);

  if (!authConfigured) return <p className="center error">Sign-in is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</p>;
  if (session === undefined) return <p className="center muted">Loading…</p>;
  if (!session) return <SignIn />;
  if (needsPassword) return <ChoosePassword onDone={() => { setNeedsPassword(false); window.history.replaceState(null, "", window.location.pathname); }} />;
  if (error) return <div className="center stack"><Problem error={error} /><div className="actions"><button onClick={loadMe}>Try again</button><button onClick={() => supabase.auth.signOut()}>Sign out</button></div></div>;
  if (!me) return <p className="center muted">Loading your company…</p>;
  if (!me.membership) return <Onboarding email={me.user.email} onDone={loadMe} />;
  if (me.membership.role === "DRIVER") return <Shell me={me} tabs={[]}><DriverApp /></Shell>;
  return <Office me={me} />;
}
