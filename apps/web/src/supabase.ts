import { createClient } from "@supabase/supabase-js";

// Sign-in runs on Supabase Auth. The URL and publishable key are public by
// design (they ship in the bundle); data access goes through the API, which
// checks the signed-in person's company and role on every request.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const authConfigured = Boolean(url && key);

// Read before the client consumes the link: an invite or password-reset link
// signs the person in, and they must then choose a password.
export const arrivedFrom = new URLSearchParams(window.location.hash.slice(1)).get("type");

export const supabase = createClient(url || "http://localhost:54321", key || "missing", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
