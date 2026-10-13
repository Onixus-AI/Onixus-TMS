import { supabase } from "./db/supabase.js";
import type { Env } from "./env.js";

// Load documents (POD, BOL, photos) live in the private "documents" bucket.
// The API hands out short-lived signed URLs; files never pass through it.
export type SignedUpload = { path: string; token: string; signedUrl: string };

export interface FileStore {
  uploadUrl(path: string): Promise<SignedUpload>;
  downloadUrl(path: string): Promise<string>;
}

const BUCKET = "documents";

export function supabaseFiles(env: Env): FileStore {
  const bucket = () => supabase(env).storage.from(BUCKET);
  return {
    async uploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error || !data) throw Object.assign(new Error(`Storage: ${error?.message ?? "no upload URL"}`), { status: 502 });
      return { path: data.path, token: data.token, signedUrl: data.signedUrl };
    },
    async downloadUrl(path) {
      const { data, error } = await bucket().createSignedUrl(path, 3600);
      if (error || !data) throw Object.assign(new Error(`Storage: ${error?.message ?? "no download URL"}`), { status: 502 });
      return data.signedUrl;
    },
  };
}

export type AuthUser = { id: string; email: string };

/** Who a Supabase access token belongs to, or null when it is invalid or expired. */
export async function supabaseUser(env: Env, token: string): Promise<AuthUser | null> {
  const { data, error } = await supabase(env).auth.getUser(token);
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

/** Email someone a link to join; if they already have an account, the pending invitation waits for their next sign-in. */
export async function supabaseInvite(env: Env, email: string, redirectTo?: string): Promise<"sent" | "existing_user"> {
  const { error } = await supabase(env).auth.admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : undefined);
  if (!error) return "sent";
  if (/already been registered|already registered|exists/i.test(error.message)) return "existing_user";
  throw Object.assign(new Error(`Invite failed: ${error.message}`), { status: 502 });
}
