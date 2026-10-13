import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { CONTAINER_DEFAULTS, CONTAINER_SIZES, CONTAINER_TYPES, containerNumberProblem, MOVE_TYPES, normalizeContainerNumber } from "@onixus/core";
import { HttpError, isoDate, money, text, uuid, type Ctx } from "../http.js";
import { currentCaller } from "../auth.js";
import { moveLoad, type Load } from "./loads.js";

// Delivery orders. Drayage work arrives as a delivery order (import) or a
// booking confirmation (export), usually a PDF in an email. Upload it or
// paste the email, the AI reads it into a draft, the dispatcher checks the
// draft, and one load per container is created (and booked, when complete).

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const str = nullable({ type: "string" });

/** What the AI must return: every field present, null when the document does not say. */
export const ORDER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "direction", "customer_name", "customer_reference", "steamship_line_name", "steamship_line_scac", "bill_of_lading", "booking_number",
    "pickup_number", "vessel", "voyage", "vessel_eta", "terminal_name", "last_free_day", "cutoff_at", "site", "commodity", "hazmat", "notes", "containers",
  ],
  properties: {
    direction: nullable({ type: "string", enum: ["IMPORT", "EXPORT"] }),
    customer_name: str,
    customer_reference: str,
    steamship_line_name: str,
    steamship_line_scac: str,
    bill_of_lading: str,
    booking_number: str,
    pickup_number: str,
    vessel: str,
    voyage: str,
    vessel_eta: str,
    terminal_name: str,
    last_free_day: str,
    cutoff_at: str,
    site: nullable({
      type: "object",
      additionalProperties: false,
      required: ["name", "address", "city", "state", "zip"],
      properties: { name: str, address: str, city: str, state: str, zip: str },
    }),
    commodity: str,
    hazmat: { type: "boolean" },
    notes: str,
    containers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["container_number", "size", "type", "weight_lbs", "seal_number"],
        properties: {
          container_number: str,
          size: nullable({ type: "string", enum: ["20", "40", "45"] }),
          type: nullable({ type: "string", enum: [...CONTAINER_TYPES] }),
          weight_lbs: nullable({ type: "integer" }),
          seal_number: str,
        },
      },
    },
  },
} as const;

export const ORDER_PROMPT = `You read drayage paperwork: delivery orders (imports) and booking confirmations (exports) sent to a trucking company.
Extract only what the document states. Use null for anything it does not say; never guess.
- direction: IMPORT for a delivery order or arrival notice, EXPORT for a booking or export order.
- customer_name: who sent the order and pays for the move (the forwarder, broker or importer), not the trucking company.
- site: for an import, where the container is delivered (consignee / deliver to); for an export, where it is loaded (shipper / pick up at).
- terminal_name: the port terminal the container is picked up from (import) or delivered to (export), as written.
- Dates as YYYY-MM-DD; cutoff_at as an ISO date-time when a time is given, else the date.
- weight_lbs in pounds (convert kg × 2.20462 and round).
- containers: one entry per container listed; container_number exactly as printed, without spaces.`;

type Raw = z.infer<typeof rawOrder>;
const loose = z.string().nullable().catch(null);
const rawOrder = z.object({
  direction: z.enum(["IMPORT", "EXPORT"]).nullable().catch(null),
  customer_name: loose, customer_reference: loose, steamship_line_name: loose, steamship_line_scac: loose,
  bill_of_lading: loose, booking_number: loose, pickup_number: loose, vessel: loose, voyage: loose, vessel_eta: loose,
  terminal_name: loose, last_free_day: loose, cutoff_at: loose,
  site: z.object({ name: loose, address: loose, city: loose, state: loose, zip: loose }).nullable().catch(null),
  commodity: loose, hazmat: z.boolean().catch(false), notes: loose,
  containers: z.array(z.object({
    container_number: loose,
    size: z.enum(CONTAINER_SIZES).nullable().catch(null),
    type: z.enum(CONTAINER_TYPES).nullable().catch(null),
    weight_lbs: z.number().int().positive().max(200_000).nullable().catch(null),
    seal_number: loose,
  })).catch([]),
});

const dateOnly = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const words = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["inc", "llc", "ltd", "corp", "the", "terminal", "terminals", "container", "co"].includes(w));
/** The best name match: most shared words, at least one. */
function bestMatch<T extends { id: string }>(name: string | null | undefined, rows: T[], nameOf: (r: T) => string | null | undefined): T | null {
  const want = new Set(words(name));
  if (!want.size) return null;
  let best: T | null = null, score = 0;
  for (const r of rows) {
    const s = words(nameOf(r)).filter((w) => want.has(w)).length;
    if (s > score) (best = r), (score = s);
  }
  return best;
}

/** Turn the AI's answer into a draft: cleaned fields, checked container numbers, and matches to what this company already has. */
async function draftFrom(ctx: Ctx, raw: Raw) {
  const store = ctx.store();
  const [customers, terminals] = await Promise.all([
    store.list<{ id: string; type: string; company_name: string; scac_code?: string | null }>("customers", {}, { limit: 2000 }),
    store.list<{ id: string; name: string; code?: string | null }>("port_terminals", {}, { limit: 1000 }),
  ]);
  const lines = customers.filter((c) => c.type === "STEAMSHIP_LINE");
  const scac = raw.steamship_line_scac?.toUpperCase().trim();
  const line = (scac && lines.find((l) => l.scac_code === scac)) || bestMatch(raw.steamship_line_name, lines, (l) => l.company_name);
  const customer = bestMatch(raw.customer_name, customers.filter((c) => c.type !== "STEAMSHIP_LINE"), (c) => c.company_name);
  const site = raw.site;
  const siteOwner = bestMatch(site?.name, customers.filter((c) => c.type !== "STEAMSHIP_LINE"), (c) => c.company_name);
  const locations = siteOwner ? await store.list<{ id: string; label: string; address?: string | null; city?: string | null }>("customer_locations", { customer_id: siteOwner.id }) : [];
  const location = bestMatch([site?.address, site?.city, site?.name].filter(Boolean).join(" "), locations, (l) => [l.label, l.address, l.city].filter(Boolean).join(" "));
  const terminal = bestMatch(raw.terminal_name, terminals, (t) => `${t.name} ${t.code ?? ""}`);

  const containers = raw.containers.map((c) => {
    const number = c.container_number ? normalizeContainerNumber(c.container_number) : null;
    return { container_number: number, size: c.size, type: c.type, weight_lbs: c.weight_lbs, seal_number: c.seal_number, problem: number ? containerNumberProblem(number) : "No container number" };
  });
  return {
    order: {
      direction: raw.direction, customer_name: raw.customer_name, customer_reference: raw.customer_reference,
      steamship_line_name: raw.steamship_line_name, steamship_line_scac: scac ?? null, bill_of_lading: raw.bill_of_lading, booking_number: raw.booking_number,
      pickup_number: raw.pickup_number, vessel: raw.vessel, voyage: raw.voyage, vessel_eta: dateOnly(raw.vessel_eta),
      terminal_name: raw.terminal_name, last_free_day: dateOnly(raw.last_free_day), cutoff_at: raw.cutoff_at,
      site, commodity: raw.commodity, hazmat: raw.hazmat, notes: raw.notes,
    },
    containers,
    matches: {
      customer_id: customer?.id ?? null,
      steamship_line_id: line?.id ?? null,
      terminal_id: terminal?.id ?? null,
      site_customer_id: siteOwner?.id ?? null,
      site_location_id: location?.id ?? null,
    },
  };
}

const MEDIA: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

const orgOf = (ctx: Ctx) => {
  const c = currentCaller();
  const org = c?.kind === "user" ? c.member?.org_id : c?.kind === "system" ? c.orgId : undefined;
  if (!org) throw new HttpError(403, "Join or create a company first");
  return org;
};

const container = z.object({
  container_number: z.string().max(20).transform(normalizeContainerNumber).nullish(),
  size: z.enum(CONTAINER_SIZES).nullish(),
  type: z.enum(CONTAINER_TYPES).nullish(),
  weight_lbs: z.number().int().positive().max(200_000).nullish(),
  seal_number: text(60).nullish(),
});
const createOrder = z.object({
  direction: z.enum(["IMPORT", "EXPORT"]),
  move_type: z.enum(MOVE_TYPES).optional(),
  rate: money.optional(),
  customer_id: uuid.optional(),
  new_customer: z.object({ company_name: text() }).optional(),
  steamship_line_id: uuid.optional(),
  new_steamship_line: z.object({ company_name: text(), scac_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,4}$/).optional() }).optional(),
  terminal_id: uuid.optional(),
  new_terminal: z.object({ name: text() }).optional(),
  site_location_id: uuid.optional(),
  new_site: z.object({ name: text(), address: text(300).optional(), city: text(100).optional(), state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(), zip: z.string().regex(/^\d{5}(-\d{4})?$/).optional() }).optional(),
  customer_reference: text(80).optional(),
  bill_of_lading: text(60).optional(),
  booking_number: text(60).optional(),
  pickup_number: text(60).optional(),
  vessel: text(80).optional(),
  voyage: text(40).optional(),
  vessel_eta: isoDate.optional(),
  last_free_day: isoDate.optional(),
  cutoff_at: z.string().datetime({ offset: true }).optional(),
  commodity: text().optional(),
  hazmat: z.boolean().optional(),
  notes: text(2000).optional(),
  path: text(500).optional(),
  containers: z.array(container).min(1).max(50),
  book: z.boolean().default(true),
});

export function orderRoutes(ctx: Ctx) {
  const r = Router();

  // Step 1 (for a file): where to upload it.
  r.post("/delivery-orders/upload-url", async (req, res) => {
    const { file_name } = z.object({ file_name: text(200), content_type: z.string().regex(/^(application\/pdf|image\/(jpeg|png|webp|gif))$/, "Upload a PDF or a JPEG, PNG or WebP photo") }).parse(req.body);
    const ext = file_name.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() ?? "pdf";
    res.json(await ctx.files().uploadUrl(`${orgOf(ctx)}/intake/${randomUUID()}.${ext}`));
  });

  // Step 2: read it (a file, pasted email text, or both) into a draft.
  r.post("/delivery-orders/read", async (req, res) => {
    const { path, text: pasted } = z.object({ path: text(500).optional(), text: z.string().max(100_000).optional() }).parse(req.body);
    if (!path && !pasted?.trim()) throw new HttpError(400, "Upload the delivery order or paste the email");
    let file: { base64: string; mediaType: string } | undefined;
    if (path) {
      if (!path.startsWith(`${orgOf(ctx)}/intake/`) || path.includes("..")) throw new HttpError(400, "That file is not one of your uploads");
      const mediaType = MEDIA[path.split(".").pop()!.toLowerCase()];
      if (!mediaType) throw new HttpError(400, "Upload a PDF or a JPEG, PNG or WebP photo");
      file = { base64: (await ctx.files().download(path)).toString("base64"), mediaType };
    }
    const raw = rawOrder.parse(await ctx.readOrder({ system: ORDER_PROMPT, text: pasted, file, schema: ORDER_SCHEMA as unknown as Record<string, unknown> }));
    res.json({ path: path ?? null, ...(await draftFrom(ctx, raw)) });
  });

  // Step 3: the checked draft becomes one load per container.
  r.post("/delivery-orders", async (req, res) => {
    const o = createOrder.parse(req.body);
    const bad = o.containers.flatMap((c) => (c.container_number ? [containerNumberProblem(c.container_number)].filter((p): p is string => !!p) : o.direction === "IMPORT" ? ["Every import container needs its number"] : []));
    if (bad.length) throw new HttpError(400, "Fix the container numbers first", bad);
    const store = ctx.store();
    if (o.path && (!o.path.startsWith(`${orgOf(ctx)}/intake/`) || o.path.includes(".."))) throw new HttpError(400, "That file is not one of your uploads");

    const customerId = o.customer_id ?? (o.new_customer ? (await store.insert("customers", { type: "FREIGHT_FORWARDER", company_name: o.new_customer.company_name, compliance_status: "PENDING" })).id : null);
    const lineId = o.steamship_line_id ?? (o.new_steamship_line ? (await store.insert("customers", { type: "STEAMSHIP_LINE", company_name: o.new_steamship_line.company_name, scac_code: o.new_steamship_line.scac_code ?? null, compliance_status: "PENDING" })).id : null);
    let terminalId = o.terminal_id ?? null;
    if (!terminalId && o.new_terminal) {
      const [same] = (await ctx.db().list<{ id: string; name: string }>("port_terminals", {}, { limit: 1000 })).filter((t) => t.name.toLowerCase() === o.new_terminal!.name.toLowerCase());
      terminalId = same?.id ?? (await ctx.db().insert("port_terminals", { name: o.new_terminal.name })).id;
    }
    let siteId = o.site_location_id ?? null;
    if (!siteId && o.new_site) {
      const owner = (await store.list<{ id: string; company_name: string }>("customers", {}, { limit: 2000 })).find((c) => c.company_name.toLowerCase() === o.new_site!.name.toLowerCase())
        ?? (await store.insert("customers", { type: o.direction === "IMPORT" ? "WAREHOUSE" : "SHIPPER", company_name: o.new_site.name, compliance_status: "PENDING" }));
      siteId = (await store.insert("customer_locations", { customer_id: owner.id, label: o.new_site.name, address: o.new_site.address ?? null, city: o.new_site.city ?? null, state: o.new_site.state ?? null, zip: o.new_site.zip ?? null })).id;
    }

    const created: Load[] = [];
    const problems: Record<string, string[]> = {};
    for (const c of o.containers) {
      const load = await store.insert<Load>("loads", {
        ...CONTAINER_DEFAULTS, hazmat: o.hazmat ?? false, is_street_turn: false, status: "DRAFT", source: "DELIVERY_ORDER", delivery_order_path: o.path ?? null,
        equipment_type: "CONTAINER", direction: o.direction, move_type: o.move_type ?? (o.direction === "IMPORT" ? "IMPORT_LIVE" : "EXPORT_LIVE"),
        customer_id: customerId, steamship_line_id: lineId, terminal_id: terminalId,
        ...(o.direction === "IMPORT" ? { delivery_location_id: siteId } : { pickup_location_id: siteId }),
        rate: o.rate ?? null, container_number: c.container_number ?? null, container_size: c.size ?? null, container_type: c.type ?? null,
        weight_lbs: c.weight_lbs ?? null, seal_number: c.seal_number ?? null, commodity: o.commodity ?? null, notes: o.notes ?? null,
        bol_number: o.bill_of_lading ?? null, booking_number: o.booking_number ?? null, pickup_number: o.pickup_number ?? null,
        customer_reference: o.customer_reference ?? null, vessel: o.vessel ?? null, voyage: o.voyage ?? null, vessel_eta: o.vessel_eta ?? null,
        last_free_day: o.direction === "IMPORT" ? o.last_free_day ?? null : null, cutoff_at: o.direction === "EXPORT" ? o.cutoff_at ?? null : null,
      });
      await store.insert("load_events", { load_id: load.id, from_status: null, to_status: "DRAFT", note: "From a delivery order" });
      let final = load;
      if (o.book) {
        try {
          final = await moveLoad(ctx, load, "BOOKED", "Booked from the delivery order");
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          problems[load.load_number ?? c.container_number ?? load.id] = e.problems ?? [e.message];
        }
      }
      created.push(final);
    }
    res.status(201).json({ loads: created, problems });
  });

  return r;
}
