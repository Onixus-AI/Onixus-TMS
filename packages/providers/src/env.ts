import { NotConfiguredError } from "./types.js";

export type Env = Record<string, string | undefined>;

export function missingVars(env: Env, names: string[]): string[] {
  return names.filter((n) => !env[n]?.trim());
}

/** Read required variables, or throw NotConfiguredError naming every missing one. */
export function requireVars<K extends string>(env: Env, provider: string, names: K[]): Record<K, string> {
  const missing = missingVars(env, names);
  if (missing.length) throw new NotConfiguredError(provider, missing);
  return Object.fromEntries(names.map((n) => [n, env[n]!.trim()])) as Record<K, string>;
}

/** fetch with a timeout; returns parsed JSON or throws with the upstream body. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  onError: (status: number, body: string) => Error,
): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw onError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}
