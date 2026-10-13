import { fetchJson } from "../env.js";
import { ProviderError } from "../types.js";

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string };

/**
 * OAuth2 refresh-token grant with an in-memory access-token cache. Used by
 * Gmail and Microsoft Graph: the mailbox owner authorizes once, the refresh
 * token lives in the environment, and access tokens are minted as needed.
 * Microsoft rotates refresh tokens, so a newly issued one replaces the old.
 */
export class RefreshTokenAuth {
  private accessToken = "";
  private expiresAt = 0;

  constructor(
    private readonly provider: string,
    private readonly tokenUrl: string,
    private readonly params: Record<string, string>,
    private refreshToken: string,
    /** Basic auth with client_id:client_secret instead of body fields (Intuit), and a hook to keep a rotated refresh token. */
    private readonly opts: { basic?: boolean; onRotate?: (refreshToken: string) => void } = {},
  ) {}

  async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const { client_id, client_secret, ...rest } = this.params;
    const basic = this.opts.basic && client_id && client_secret;
    const body = new URLSearchParams({ ...(basic ? rest : this.params), grant_type: "refresh_token", refresh_token: this.refreshToken });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (basic) headers.Authorization = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString("base64")}`;
    const t = await fetchJson<TokenResponse>(this.tokenUrl, { method: "POST", headers, body }, (status, text) => new ProviderError(`${this.provider} sign-in`, status, text));
    this.accessToken = t.access_token;
    this.expiresAt = Date.now() + t.expires_in * 1000;
    if (t.refresh_token && t.refresh_token !== this.refreshToken) {
      this.refreshToken = t.refresh_token;
      this.opts.onRotate?.(t.refresh_token);
    }
    return this.accessToken;
  }
}

/** Header values must be single-line: a CR/LF would let input inject headers. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
