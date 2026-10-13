import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api } from "./api";
import { arrivedFrom, authConfigured, supabase } from "./supabase";
import { ChoosePassword, Onboarding, SignIn, Team } from "./account";
import { Billing } from "./billing";
import { ConnectionsPage } from "./connections";
import { DriverApp } from "./driver";
import { NavContext, type Intent, type Tab } from "./nav";
import { Overview } from "./overview";
import { Platform } from "./platform";
import { Containers, Customers, Dispatch, Fleet, Loads, Problem } from "./trucking";

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

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7ee0c3" />
          <stop offset="1" stopColor="#3987e5" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="11" fill="none" stroke="url(#lg)" strokeWidth="4" />
      <rect x="13" y="3" width="6" height="9" rx="2" fill="url(#lg)" />
    </svg>
  );
}

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

function Shell({ me, children, tabs, tab, setTab }: { me: Me; children: React.ReactNode; tabs: [Tab, string][]; tab?: Tab; setTab?: (t: Tab) => void }) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <strong>Onixus</strong>
            <span className="org">{me.organization?.name ?? "Logistics OS"}</span>
          </div>
        </div>
        {tabs.length > 0 && (
          <nav className="tabs" aria-label="Sections">
            {tabs.map(([id, label]) => (
              <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab?.(id)}>{label}</button>
            ))}
          </nav>
        )}
        <Account me={me} />
      </header>
      <main>{children}</main>
    </div>
  );
}

function Office({ me }: { me: Me }) {
  const owner = me.membership?.role === "OWNER";
  const drives = Boolean(me.membership?.driver_id);
  // Owner-operators mostly drive: open on their trips.
  const returned = connectionReturn;
  const [tab, setTab] = useState<Tab>(returned ? "connections" : me.organization?.kind === "OWNER_OPERATOR" && drives ? "mytrips" : "overview");
  const [intent, setIntent] = useState<Intent>({});
  const go = useCallback((t: Tab, i: Intent = {}) => {
    setIntent(i);
    setTab(t);
    window.scrollTo({ top: 0 });
  }, []);
  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ...(drives ? ([["mytrips", "My trips"]] as [Tab, string][]) : []),
    ["loads", "Loads"], ["dispatch", "Dispatch"], ["containers", "Containers"], ["billing", "Billing"], ["fleet", "Fleet"], ["customers", "Customers"],
    ["connections", "Connections"],
    ...(owner ? ([["team", "Team"], ["platform", "Platform"]] as [Tab, string][]) : []),
  ];
  return (
    <NavContext.Provider value={{ go, intent, clearIntent: () => setIntent({}) }}>
      <Shell me={me} tabs={tabs} tab={tab} setTab={(t) => go(t)}>
        {tab === "overview" && <Overview me={me} />}
        {tab === "mytrips" && <DriverApp />}
        {tab === "loads" && <Loads />}
        {tab === "dispatch" && <Dispatch />}
        {tab === "containers" && <Containers />}
        {tab === "billing" && <Billing owner={owner} />}
        {tab === "fleet" && <Fleet />}
        {tab === "customers" && <Customers />}
        {tab === "team" && <Team />}
        {tab === "connections" && <ConnectionsPage owner={owner} notice={returned} />}
        {tab === "platform" && <Platform />}
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
