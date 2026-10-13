import dns from "node:dns";
import https from "node:https";
import net from "node:net";

// Automations: Zapier, Make and n8n start a workflow when Onixus posts an
// event (a load booked, delivered, invoiced) to the company's webhook. The
// URL is typed in by a company, so the POST only goes to a public internet
// address over https on port 443, checked on the address actually connected to.

export type AutomationEvent = { event: string; at: string; company_id: string | null; data: Record<string, unknown> };
export interface Automation {
  readonly name: string;
  send(e: AutomationEvent): Promise<void>;
}

/** Whether an IP is on the public internet (not private, loopback, link-local, CGNAT, multicast or reserved). */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]!);
    if (v === "::" || v === "::1") return false;
    return !/^(f[cd]|fe[89ab]|ff|64:ff9b:|2001:db8:|::ffff:)/.test(v);
  }
  return false;
}

const publicLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { all: true, family: (opts as dns.LookupOptions).family ?? 0 }, (err, addrs) => {
    if (err) return (cb as (e: Error) => void)(err);
    const bad = addrs.find((a) => !isPublicIp(a.address));
    if (bad || !addrs.length) return (cb as (e: Error) => void)(new Error(`refusing to connect to ${bad?.address ?? host}`));
    if ((opts as dns.LookupAllOptions).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
    (cb as (e: null, a: string, f: number) => void)(null, addrs[0]!.address, addrs[0]!.family);
  });
};

/** Refuses anything but a plain https URL on 443 with a public hostname. */
export function checkWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That isn't a valid URL");
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) throw new Error("Use a plain https:// webhook URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if ((net.isIP(host) && !isPublicIp(host)) || host === "localhost" || !host.includes(".")) throw new Error("Use a public webhook URL");
  return u;
}

export function postJson(raw: string, body: unknown, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = checkWebhookUrl(raw);
    } catch (e) {
      return reject(e);
    }
    const data = JSON.stringify(body);
    const req = https.request(u, { method: "POST", lookup: publicLookup, timeout: timeoutMs, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "user-agent": "Onixus-Automations/1.0" } }, (res) => {
      res.resume();
      const s = res.statusCode ?? 0;
      s >= 200 && s < 300 ? resolve(s) : reject(new Error(`the webhook answered ${s}`));
    });
    req.on("timeout", () => req.destroy(new Error("the webhook didn't answer in time")));
    req.on("error", reject);
    req.end(data);
  });
}

/** How webhooks go out; tests swap `post` for a stand-in. */
export const webhookPoster: { post: (url: string, body: unknown) => Promise<unknown> } = { post: postJson };

export function webhookAutomation(name: string, url: string): Automation {
  checkWebhookUrl(url);
  return { name, send: async (e) => void (await webhookPoster.post(url, e)) };
}
