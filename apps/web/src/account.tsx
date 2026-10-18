import { useState, type FormEvent } from "react";
import { api } from "./api";
import { supabase } from "./supabase";
import { Field, formBody, human, Problem, Select, useAction, useGet, type Row } from "./trucking";

// Signing in, choosing a password from an invite or reset link, starting a
// company, and (for owners) managing the team.

export function SignIn() {
  const [mode, setMode] = useState<"in" | "up" | "reset">("in");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")).trim(), password = String(f.get("password") ?? "");
    setBusy(true);
    setError(null);
    setNote("");
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) throw error;
        if (!data.session) setNote("Check your email and tap the link to confirm your account, then sign in.");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) throw error;
        setNote("If that email has an account, a reset link is on its way.");
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <h1>Onixus TMS</h1>
      <p className="muted">Transport operations, connected to your business workspace.</p>
      <form className="card stack" onSubmit={submit}>
        <h3>{mode === "in" ? "Sign in" : mode === "up" ? "Create your account" : "Reset your password"}</h3>
        <Field label="Email"><input name="email" type="email" autoComplete="email" required /></Field>
        {mode !== "reset" && (
          <Field label="Password"><input name="password" type="password" minLength={8} autoComplete={mode === "in" ? "current-password" : "new-password"} required /></Field>
        )}
        <Problem error={error} />
        {note && <p className="ok-text">{note}</p>}
        <button type="submit" disabled={busy}>{busy ? "…" : mode === "in" ? "Sign in" : mode === "up" ? "Create account" : "Send reset link"}</button>
      </form>
      <p className="small">
        {mode !== "in" && <button className="link" onClick={() => setMode("in")}>Sign in</button>}
        {mode !== "up" && <button className="link" onClick={() => setMode("up")}>Create an account</button>}
        {mode !== "reset" && <button className="link" onClick={() => setMode("reset")}>Forgot password?</button>}
      </p>
    </div>
  );
}

/** After an invite or reset link: the person is signed in and picks a password. */
export function ChoosePassword({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setError(error);
    else onDone();
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h3>Choose a password</h3>
        <Field label="New password"><input name="password" type="password" minLength={8} autoComplete="new-password" required /></Field>
        <Problem error={error} />
        <button type="submit">Save and continue</button>
      </form>
    </div>
  );
}

/** First sign-in without a company: start one (or ask your company for an invite). */
export function Onboarding({ email, onDone }: { email: string; onDone: () => void }) {
  const [kind, setKind] = useState("COMPANY");
  const action = useAction(onDone);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    action.run(() => api("/onboarding", { method: "POST", body: formBody(e.currentTarget) }));
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h3>Set up your business</h3>
        <p className="muted small">Signed in as {email}. Driving for a company? Ask the owner to invite this email instead, then sign in again.</p>
        <Field label="I am">
          <Select name="kind" value={kind} onChange={setKind} options={[["COMPANY", "A transport or service business"], ["OWNER_OPERATOR", "An owner-operator (I drive my own truck or van)"]]} />
        </Field>
        <Field label="Business name"><input name="company_name" required /></Field>
        {kind === "OWNER_OPERATOR" && (
          <>
            <Field label="Your name"><input name="your_name" required /></Field>
            <Field label="Phone"><input name="phone" type="tel" /></Field>
          </>
        )}
        <div className="fields">
          <Field label="USDOT # (optional)"><input name="dot_number" inputMode="numeric" /></Field>
          <Field label="MC # (optional)"><input name="mc_number" inputMode="numeric" /></Field>
        </div>
        <Problem error={action.error} />
        <button type="submit" disabled={action.busy}>Create</button>
      </form>
      <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
  );
}

export function Team() {
  const team = useGet<{ members: Row[]; invitations: Row[] }>("/members");
  const drivers = useGet<{ drivers: Row[] }>("/drivers");
  const action = useAction(team.reload);
  const [role, setRole] = useState("DRIVER");
  const driverOptions: [string, string][] = (drivers.data?.drivers ?? []).map((d) => [d.id, d.name]);
  const invite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    action.run(() => api("/members/invitations", { method: "POST", body: formBody(form) })).then((ok) => ok && form.reset());
  };
  const patch = (id: string, body: Record<string, unknown>) => action.run(() => api(`/members/${id}`, { method: "PATCH", body }));
  return (
    <div className="stack">
      <form className="card stack" onSubmit={invite}>
        <h3>Invite someone</h3>
        <p className="muted small">They get an email link, choose a password and land in the right app: drivers in the driver app, dispatchers in the office. Add a driver under Fleet first, then invite them as that driver.</p>
        <div className="fields">
          <Field label="Email"><input name="email" type="email" required /></Field>
          <Field label="Role"><Select name="role" value={role} onChange={setRole} options={[["DRIVER", "Driver"], ["DISPATCHER", "Dispatcher"], ["OWNER", "Owner"]]} /></Field>
          {role === "DRIVER" && <Field label="Drives as"><Select name="driver_id" required empty="Choose driver…" options={driverOptions} /></Field>}
        </div>
        <Problem error={action.error} />
        <button type="submit" disabled={action.busy}>Send invite</button>
      </form>
      <Problem error={team.error} />
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Drives as</th><th></th></tr></thead>
        <tbody>
          {team.data?.members.map((m) => (
            <tr key={m.id} className={m.disabled_at ? "muted" : ""}>
              <td>{m.email}</td>
              <td>
                <select value={m.role} onChange={(e) => patch(m.id, { role: e.target.value })} disabled={Boolean(m.disabled_at)}>
                  <option value="OWNER">owner</option><option value="DISPATCHER">dispatcher</option><option value="DRIVER">driver</option>
                </select>
              </td>
              <td>
                <select value={m.driver_id ?? ""} onChange={(e) => patch(m.id, { driver_id: e.target.value || null })}>
                  <option value="">—</option>
                  {driverOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </td>
              <td><button onClick={() => patch(m.id, { disabled: !m.disabled_at })}>{m.disabled_at ? "Restore access" : "Remove access"}</button></td>
            </tr>
          ))}
          {team.data?.invitations.map((i) => (
            <tr key={i.id} className="muted"><td>{i.email}</td><td>{human(i.role)} (invited)</td><td></td><td></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
