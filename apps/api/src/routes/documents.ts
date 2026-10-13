import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, text, type Ctx } from "../http.js";
import { currentCaller } from "../auth.js";
import { moveLoad, type Load } from "./loads.js";

export const DOCUMENT_KINDS = ["POD", "BOL", "RATE_CONFIRMATION", "PHOTO", "OTHER"] as const;
const ALLOWED_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

const uploadRequest = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  file_name: text(200),
  content_type: z.string().regex(ALLOWED_TYPES, "Upload a photo (JPEG, PNG, WebP, HEIC) or a PDF"),
});
const record = z.object({ kind: z.enum(DOCUMENT_KINDS), path: text(500), file_name: text(200).optional(), content_type: z.string().max(100).optional() });

type Doc = { id: string; load_id: string; kind: string; path: string; file_name?: string | null; created_at?: string };

/** Files live under <organization>/<load>/, so a path proves which load it belongs to. */
const folderFor = (_ctx: Ctx, load: Load) => `${(load as Load & { org_id?: string }).org_id ?? "shared"}/${load.id}/`;

/**
 * Step 1 of an upload: a signed URL for one file under the load's folder.
 * The browser sends the file straight to storage, then calls `recordDocument`.
 */
export async function uploadUrl(ctx: Ctx, load: Load, body: unknown) {
  const req = uploadRequest.parse(body);
  const ext = (req.file_name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? req.content_type.split("/")[1]).toLowerCase();
  const path = `${folderFor(ctx, load)}${req.kind.toLowerCase()}-${randomUUID()}.${ext}`;
  return ctx.files().uploadUrl(path);
}

/** Step 2: remember the uploaded file. A proof of delivery on a delivered load marks it POD received. */
export async function recordDocument(ctx: Ctx, load: Load, body: unknown) {
  const doc = record.parse(body);
  if (!doc.path.startsWith(folderFor(ctx, load)) || doc.path.includes("..")) throw new HttpError(400, "That file does not belong to this load");
  const c = currentCaller();
  const row = await ctx.store().insert("load_documents", {
    load_id: load.id, kind: doc.kind, path: doc.path, file_name: doc.file_name ?? null, content_type: doc.content_type ?? null,
    uploaded_by: c?.kind === "user" ? c.user.id : null,
  });
  let updated = load;
  if (doc.kind === "POD" && load.status === "DELIVERED") updated = await moveLoad(ctx, load, "POD_RECEIVED", "Proof of delivery uploaded");
  return { document: row, load: updated };
}

/** A load's documents with links that work for an hour. */
export async function listDocuments(ctx: Ctx, load: Load) {
  const docs = await ctx.store().list<Doc>("load_documents", { load_id: load.id }, { order: "created_at" });
  return Promise.all(docs.map(async (d) => ({ ...d, url: await ctx.files().downloadUrl(d.path) })));
}

