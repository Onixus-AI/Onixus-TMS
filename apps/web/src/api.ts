import { supabase } from "./supabase";

// Thin client for the Onixus Logistics OS API. Requests carry the signed-in
// person's Supabase access token; platform tools (Onixus's own email, CRM and
// AI) carry the platform key instead, kept only in this tab's session storage.

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:4000";
const KEY_STORE = "onixus-platform-key";

export function getKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}
export function setKey(key: string) {
  try {
    sessionStorage.setItem(KEY_STORE, key);
  } catch {
    /* private mode: key lasts for this page only */
  }
}

export type ProviderStatus = { capability: string; provider: string; available: boolean; configured: boolean; missing: string[] };

export class ApiError extends Error {
  /** The API's list of things to fix (dispatch checks, booking requirements, …). */
  constructor(readonly status: number, message: string, readonly problems: string[] = []) {
    super(message);
  }
}

async function request<T>(path: string, token: string, init: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, Array.isArray(data.problems) ? data.problems : []);
  return data as T;
}

/** A request as the signed-in person. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  return request<T>(path, data.session?.access_token ?? "", init);
}

/** A request with the platform key (Onixus staff only). */
export function platformApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return request<T>(path, getKey(), init);
}

/** Upload a POD, BOL or photo for a load: a signed URL from the API, the file straight to storage, then the record. */
export async function uploadDocument(scope: "" | "/driver", loadId: string, kind: string, file: File) {
  const contentType = file.type || "image/jpeg";
  const up = await api<{ path: string; token: string }>(`${scope}/loads/${loadId}/documents/upload-url`, { method: "POST", body: { kind, file_name: file.name || "photo.jpg", content_type: contentType } });
  const { error } = await supabase.storage.from("documents").uploadToSignedUrl(up.path, up.token, file, { contentType });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return api(`${scope}/loads/${loadId}/documents`, { method: "POST", body: { kind, path: up.path, file_name: file.name, content_type: contentType } });
}

export const apiBase = BASE;
