import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api } from "./api";
import { arrivedFrom, authConfigured, supabase } from "./supabase";
import { ChoosePassword, Onboarding, SignIn, Team } from "./account";
import { DriverApp } from "./driver";
import { Platform } from "./platform";
import { Containers, Customers, Dispatch, Fleet, Loads, Problem } from "./trucking";

type Me = {
  user: { id: string; email: string };
  membership: { role: "OWNER" | "DISPATCHER" | "DRIVER"; driver_id: string | null } | null;
  organization: { name: string; kind: string } | null;
};
type Tab = "loads" | "dispatch" | "containers" | "fleet" | "customers" | "team" | "mytrips" | "platform";

function Office({ me }: { me: Me }) {
  const owner = me.membership?.role === "OWNER";
  const drives = Boolean(me.membership?.driver_id);
  // Owner-operators mostly drive: open on their trips.
  const [tab, setTab] = useState<Tab>(me.organization?.kind === "OWNER_OPERATOR" && drives ? "mytrips" : "loads");
  const tabs: [Tab, string][] = [
    ...(drives ? ([["mytrips", "My trips"]] as [Tab, string][]) : []),
    ["loads", "Loads"], ["dispatch", "Dispatch"], ["containers", "Containers"], ["fleet", "Fleet"], ["customers", "Customers"],
    ...(owner ? ([["team", "Team"], ["platform", "Platform"]] as [Tab, string][]) : []),
  ];
  return (
    <>
      <nav>
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      <main>
        {tab === "mytrips" && <DriverApp />}
        {tab === "loads" && <Loads />}
        {tab === "dispatch" && <Dispatch />}
        {tab === "containers" && <Containers />}
        {tab === "fleet" && <Fleet />}
        {tab === "customers" && <Customers />}
        {tab === "team" && <Team />}
        {tab === "platform" && <Platform />}
      </main>
    </>
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

  if (!authConfigured) return <p className="shell error">Sign-in is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</p>;
  if (session === undefined) return <p className="shell muted">Loading…</p>;
  if (!session) return <SignIn />;
  if (needsPassword) return <ChoosePassword onDone={() => { setNeedsPassword(false); window.history.replaceState(null, "", window.location.pathname); }} />;
  if (error) return <div className="shell"><Problem error={error} /><button onClick={loadMe}>Try again</button> <button onClick={() => supabase.auth.signOut()}>Sign out</button></div>;
  if (!me) return <p className="shell muted">Loading your company…</p>;
  if (!me.membership) return <Onboarding email={me.user.email} onDone={loadMe} />;

  return (
    <div className="shell">
      <header>
        <div>
          <h1>{me.organization?.name ?? "Onixus Logistics OS"}</h1>
          <div className="muted small">Onixus Logistics OS · {me.user.email} · {me.membership.role.toLowerCase()}</div>
        </div>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      {me.membership.role === "DRIVER" ? <main><DriverApp /></main> : <Office me={me} />}
    </div>
  );
}
