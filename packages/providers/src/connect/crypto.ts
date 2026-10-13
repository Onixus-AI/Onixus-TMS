import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Companies' connection credentials (refresh tokens, API keys) are stored
// sealed with AES-256-GCM under CONNECTIONS_SECRET, so a database read alone
// never yields a usable key. OAuth `state` is signed with the same secret.

function key(secret: string): Buffer {
  if (!secret || secret.length < 32) throw new Error("CONNECTIONS_SECRET must be set to a random secret of at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

export function seal(secret: string, data: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(secret: string, sealed: string): Record<string, string> {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable connection credentials");
  const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8"));
}

/** A short-lived, tamper-proof token carrying JSON (OAuth state). */
export function signToken(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key(secret)).update(body).digest("base64url")}`;
}

export function verifyToken<T>(secret: string, token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", key(secret)).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
  return payload.exp && payload.exp < Date.now() ? null : payload;
}
