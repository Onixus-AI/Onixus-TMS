import { supabase } from "./db/supabase.js";
import type { Env } from "./env.js";

// Load documents (POD, BOL, photos) live in the private "documents" bucket.
// The API hands out short-lived signed URLs; files never pass through it.
export type SignedUpload = { path: string; token: string; signedUrl: string };

export interface FileStore {
  uploadUrl(path: string): Promise<SignedUpload>;
  /** A signed link to one file, valid for `seconds` (default one hour). */
  downloadUrl(path: string, seconds?: number): Promise<string>;
  /** Whether the file is in storage. Optional so older test doubles still fit. */
  exists?(path: string): Promise<boolean>;
  /** The file's bytes, for the API to read itself (delivery orders). */
  download(path: string): Promise<Buffer>;
}

const BUCKET = "documents";

/** Files in a private bucket: "documents" (loads) by default, "mortuary-documents" for mortuary cases. */
export function supabaseFiles(env: Env, bucketName: string = BUCKET): FileStore {
  const bucket = () => supabase(env).storage.from(bucketName);
  return {
    async uploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error || !data) throw Object.assign(new Error(`Storage: ${error?.message ?? "no upload URL"}`), { status: 502 });
      return { path: data.path, token: data.token, signedUrl: data.signedUrl };
    },
    async downloadUrl(path, seconds = 3600) {
      const { data, error } = await bucket().createSignedUrl(path, seconds);
      if (error || !data) throw Object.assign(new Error(`Storage: ${error?.message ?? "no download URL"}`), { status: 502 });
      return data.signedUrl;
    },
    async exists(path) {
      const slash = path.lastIndexOf("/");
      const { data, error } = await bucket().list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 2 });
      if (error) throw Object.assign(new Error(`Storage: ${error.message}`), { status: 502 });
      return (data ?? []).some((f) => f.name === path.slice(slash + 1));
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) throw Object.assign(new Error(`Storage: ${error?.message ?? "file not found"}`), { status: 404 });
      return Buffer.from(await data.arrayBuffer());
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
