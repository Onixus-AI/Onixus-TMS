import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireVars, type Env } from "../env.js";

// Server-side Supabase client. The service-role key bypasses row-level
// security, so it must only ever live on the API server, never in the web app.
export const SUPABASE_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

export function supabase(env: Env): SupabaseClient {
  const v = requireVars(env, "Supabase", [...SUPABASE_VARS]);
  return createClient(v.SUPABASE_URL, v.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
