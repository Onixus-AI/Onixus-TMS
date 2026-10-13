import { fetchJson } from "../env.js";
import { RefreshTokenAuth } from "../email/oauth.js";
import { ProviderError } from "../types.js";

// Google Drive and Google Sheets, with the narrow drive.file scope: Onixus
// only ever sees the folder and the spreadsheet it creates itself, never the
// rest of the company's Drive.
//  - Drive: every document uploaded on a load (BOL, POD, delivery order) is
//    copied into an "Onixus Logistics OS" folder.
//  - Sheets: an "Onixus Logistics OS · Load log" spreadsheet gets a row for
//    every load booked, moved, delivered and invoiced.

export interface Documents {
  readonly name: string;
  /** Save a file in the company's Onixus folder; returns its Drive link. */
  save(name: string, bytes: Buffer, mimeType: string): Promise<string>;
  check(): Promise<string>;
}
export interface Sheet {
  readonly name: string;
  append(row: (string | number | null)[]): Promise<void>;
  /** The log spreadsheet's link, creating it if needed. */
  check(): Promise<string>;
}

type Opts = { clientId: string; clientSecret: string; refreshToken: string; tokenUrl?: string; driveUrl?: string; uploadUrl?: string; sheetsUrl?: string; onRotate?: (t: string) => void };
const FOLDER = "Onixus Logistics OS";
const LOG = "Onixus Logistics OS · Load log";
export const LOG_HEADER = ["When", "Event", "Load", "Container", "From", "To", "Details"];

function google(o: Opts, label: string) {
  const auth = new RefreshTokenAuth(label, o.tokenUrl ?? "https://oauth2.googleapis.com/token", { client_id: o.clientId, client_secret: o.clientSecret }, o.refreshToken, { onRotate: o.onRotate });
  const drive = o.driveUrl ?? "https://www.googleapis.com/drive/v3";
  const call = async <T>(url: string, init: RequestInit = {}, contentType = "application/json") =>
    fetchJson<T>(url, { ...init, headers: { Authorization: `Bearer ${await auth.token()}`, "Content-Type": contentType } }, (s, t) => new ProviderError(label, s, t));
  /** A file Onixus created, by name and type (drive.file only sees those), or null. */
  const find = async (name: string, mimeType: string) => {
    const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${mimeType}' and trashed = false`;
    const r = await call<{ files: { id: string; webViewLink?: string }[] }>(`${drive}/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=1`);
    return r.files[0] ?? null;
  };
  return { call, find, drive };
}

export function googleDrive(o: Opts): Documents {
  const g = google(o, "Google Drive");
  const upload = o.uploadUrl ?? "https://www.googleapis.com/upload/drive/v3";
  let folder: Promise<string> | null = null;
  const folderId = () =>
    (folder ??= (async () => {
      const hit = await g.find(FOLDER, "application/vnd.google-apps.folder");
      if (hit) return hit.id;
      return (await g.call<{ id: string }>(`${g.drive}/files`, { method: "POST", body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }) })).id;
    })().catch((e) => ((folder = null), Promise.reject(e))));
  return {
    name: "google-drive",
    async save(name, bytes, mimeType) {
      const boundary = `onixus${Date.now().toString(36)}`;
      const meta = JSON.stringify({ name, parents: [await folderId()] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const r = await g.call<{ id: string; webViewLink?: string }>(`${upload}/files?uploadType=multipart&fields=id,webViewLink`, { method: "POST", body }, `multipart/related; boundary=${boundary}`);
      return r.webViewLink ?? `https://drive.google.com/file/d/${r.id}/view`;
    },
    check: async () => (await folderId(), `Saving to “${FOLDER}” in Google Drive`),
  };
}

export function googleSheets(o: Opts): Sheet {
  const g = google(o, "Google Sheets");
  const sheets = o.sheetsUrl ?? "https://sheets.googleapis.com/v4";
  let log: Promise<{ id: string; url: string }> | null = null;
  const sheet = () =>
    (log ??= (async () => {
      const hit = await g.find(LOG, "application/vnd.google-apps.spreadsheet");
      if (hit) return { id: hit.id, url: hit.webViewLink ?? `https://docs.google.com/spreadsheets/d/${hit.id}` };
      const made = await g.call<{ spreadsheetId: string; spreadsheetUrl: string }>(`${sheets}/spreadsheets`, { method: "POST", body: JSON.stringify({ properties: { title: LOG }, sheets: [{ properties: { title: "Loads", gridProperties: { frozenRowCount: 1 } } }] }) });
      await append(made.spreadsheetId, LOG_HEADER);
      return { id: made.spreadsheetId, url: made.spreadsheetUrl };
    })().catch((e) => ((log = null), Promise.reject(e))));
  // RAW, never USER_ENTERED: text from customers must not become a formula.
  const append = (id: string, row: (string | number | null)[]) =>
    g.call(`${sheets}/spreadsheets/${id}/values/${encodeURIComponent("Loads!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values: [row.map((v) => v ?? "")] }) });
  return {
    name: "google-sheets",
    append: async (row) => void (await append((await sheet()).id, row)),
    check: async () => (await sheet()).url,
  };
}
