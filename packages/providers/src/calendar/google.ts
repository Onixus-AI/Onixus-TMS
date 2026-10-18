import {createHash} from "node:crypto";
import { fetchJson } from "../env.js";
import { RefreshTokenAuth } from "../email/oauth.js";
import { ProviderError } from "../types.js";

// Google Calendar: terminal and customer appointments land on the company's
// calendar. Event ids are derived from Onixus ids (Google accepts
// client-chosen ids in base32hex), so saving the same appointment twice
// updates one event instead of making two.

export type CalendarEvent = { title: string; description: string; start: string; minutes: number; location?: string };
export interface Calendar {
  readonly name: string;
  /** Create or update the event with this key. */
  available(start:string,end:string):Promise<boolean>;
  upsert(key: string, e: CalendarEvent): Promise<void>;
  remove(key: string): Promise<void>;
  /** The calendar's name, to confirm the connection works. */
  check(): Promise<string>;
}

/** A Google event id from any Onixus key: lowercase hex is valid base32hex. */
export const eventId = (key: string) => `0a${createHash("sha256").update(key).digest("hex")}`;

export function googleCalendar(o: { clientId: string; clientSecret: string; refreshToken: string; calendarId?: string; apiUrl?: string; tokenUrl?: string; onRotate?: (t: string) => void }): Calendar {
  const auth = new RefreshTokenAuth("Google Calendar", o.tokenUrl ?? "https://oauth2.googleapis.com/token", { client_id: o.clientId, client_secret: o.clientSecret }, o.refreshToken, { onRotate: o.onRotate });
  const base = `${o.apiUrl ?? "https://www.googleapis.com/calendar/v3"}/calendars/${encodeURIComponent(o.calendarId ?? "primary")}`;
  const call = async <T>(path: string, init: RequestInit = {}) =>
    fetchJson<T>(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${await auth.token()}`, "Content-Type": "application/json" } }, (s, t) => new ProviderError("Google Calendar", s, t));
  const body = (e: CalendarEvent) => {
    const start = new Date(e.start);
    return { summary: e.title, description: e.description, location: e.location, start: { dateTime: start.toISOString() }, end: { dateTime: new Date(start.getTime() + e.minutes * 60_000).toISOString() } };
  };
  return {
    name: "google-calendar",
    async available(start,end){
      const r=await fetchJson<{calendars:Record<string,{busy:{start:string;end:string}[];errors?:unknown[]}>}>(`${o.apiUrl ?? "https://www.googleapis.com/calendar/v3"}/freeBusy`,{method:"POST",headers:{Authorization:`Bearer ${await auth.token()}`,"Content-Type":"application/json"},body:JSON.stringify({timeMin:start,timeMax:end,items:[{id:o.calendarId??"primary"}]})},(s,t)=>new ProviderError("Google Calendar",s,t));
      const c=r.calendars[o.calendarId??"primary"];
      if(!c||c.errors?.length||!Array.isArray(c.busy))throw new Error("Calendar availability could not be verified.");
      return c.busy.length===0;
    },
    async upsert(key, e) {
      const id = eventId(key);
      try {
        await call(`/events/${id}`, { method: "PUT", body: JSON.stringify(body(e)) });
      } catch (err) {
        if (!(err instanceof ProviderError && err.upstreamStatus === 404)) throw err;
        await call("/events", { method: "POST", body: JSON.stringify({ id, ...body(e) }) });
      }
    },
    async remove(key) {
      try {
        await call(`/events/${eventId(key)}`, { method: "DELETE" });
      } catch (err) {
        if (!(err instanceof ProviderError && (err.upstreamStatus === 404 || err.upstreamStatus === 410))) throw err;
      }
    },
    check: async () => (await call<{ summary: string }>("")).summary,
  };
}
