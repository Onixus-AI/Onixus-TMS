// Thin client for the Onixus Logistics OS API. The API key is entered by the operator
// and kept only in this browser tab's session storage — it is never baked
// into the build, because anything in the bundle is public.

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:4000";
const KEY_STORE = "onixus-tms-api-key";

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

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${getKey()}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, Array.isArray(data.problems) ? data.problems : []);
  return data as T;
}

export const apiBase = BASE;
