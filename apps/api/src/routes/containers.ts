import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { containerNumberProblem, containerRisk, FINISHED, normalizeContainerNumber, RISK_LEVELS, streetTurnMatches, type GeoPoint } from "@onixus/core";
import { HttpError, isoDate, mustGet, text, uuid, type Ctx } from "../http.js";
import type { Load } from "./loads.js";
import { legsOf } from "./legs.js";

type Location = { id: string; lat: number | null; lng: number | null };

async function locationsFor(ctx: Ctx, loads: Load[]): Promise<Map<string, GeoPoint>> {
  const ids = [...new Set(loads.flatMap((l) => [l.pickup_location_id, l.delivery_location_id]).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await ctx.store().list<Location>("customer_locations", { id: ids }, { limit: 1000 });
  return new Map(rows.filter((r) => r.lat != null && r.lng != null).map((r) => [r.id, { lat: r.lat!, lng: r.lng! }]));
}

const openContainerLoads = (ctx: Ctx) =>
  ctx.store().list<Load>("loads", { equipment_type: "CONTAINER", status: ["DRAFT", "QUOTED", "BOOKED", "PLANNED", "ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED", "ON_HOLD"] }, { limit: 1000 });

export function containerRoutes(ctx: Ctx) {
  const r = Router();

  /** Every container whose clock needs attention, worst first: demurrage, per diem, vessel cutoffs. */
  r.get("/containers/alerts", async (_req, res) => {
    const now = ctx.now();
    const rank = (lvl: string) => RISK_LEVELS.indexOf(lvl as (typeof RISK_LEVELS)[number]);
    const alerts = (await openContainerLoads(ctx))
      .map((load) => ({ load, risk: containerRisk(load, now) }))
      .filter((a) => a.risk.level !== "NONE")
      .sort((a, b) => rank(b.risk.level) - rank(a.risk.level) || (a.load.last_free_day ?? "").localeCompare(b.load.last_free_day ?? ""));
    res.json({ alerts });
  });

  r.get("/street-turns", async (req, res) => {
    const { radius } = z.object({ radius: z.coerce.number().min(1).max(300).default(50) }).parse(req.query);
    const loads = await openContainerLoads(ctx);
    const matches = streetTurnMatches(loads, await locationsFor(ctx, loads), radius);
    const byId = new Map(loads.map((l) => [l.id, l]));
    res.json({ matches: matches.map((m) => ({ ...m, import: byId.get(m.importLoadId), export: byId.get(m.exportLoadId) })) });
  });

  // Propose a street turn: the pair is held for each other until the line approves or rejects it.
  r.post("/street-turns", async (req, res) => {
    const body = z.object({ import_load_id: uuid, export_load_id: uuid }).parse(req.body);
    const [imp, exp] = await Promise.all([mustGet<Load>(ctx, "loads", body.import_load_id, "Import load"), mustGet<Load>(ctx, "loads", body.export_load_id, "Export load")]);
    if (!streetTurnMatches([imp, exp], await locationsFor(ctx, [imp, exp]), 300).length) {
      throw new HttpError(409, "These loads cannot be street-turned: they need the same line, size and type, an emptied import and an export without a container");
    }
    const store = ctx.store();
    const a = await store.update<Load>("loads", imp.id, { is_street_turn: true, street_turn_pair_id: exp.id, street_turn_status: "PROPOSED" }, { is_street_turn: imp.is_street_turn ?? null });
    const b = a && (await store.update<Load>("loads", exp.id, { is_street_turn: true, street_turn_pair_id: imp.id, street_turn_status: "PROPOSED" }, { is_street_turn: exp.is_street_turn ?? null }));
    if (!a || !b) {
      if (a) await store.update("loads", imp.id, { is_street_turn: false, street_turn_pair_id: null, street_turn_status: null });
      throw new HttpError(409, "One of these loads was paired by someone else; reload and try again");
    }
    res.status(201).json({ import: a, export: b });
  });

  // The steamship line answered. Approved: the export takes the import's container, and the import needs no return.
  r.post("/street-turns/:importId/:decision", async (req, res) => {
    const decision = z.enum(["approve", "reject"]).parse(req.params.decision);
    const imp = await mustGet<Load>(ctx, "loads", req.params.importId, "Import load");
    if (imp.street_turn_status !== "PROPOSED" || !imp.street_turn_pair_id) throw new HttpError(409, "No proposed street turn on this load");
    const exp = await mustGet<Load>(ctx, "loads", imp.street_turn_pair_id, "Export load");
    const store = ctx.store();
    if (decision === "approve") {
      const now = ctx.now().toISOString();
      const [i, e] = await Promise.all([
        store.update("loads", imp.id, { street_turn_status: "APPROVED", empty_returned_at: now, updated_at: now }),
        store.update("loads", exp.id, { street_turn_status: "APPROVED", container_number: imp.container_number, container_type: imp.container_type ?? null, updated_at: now }),
      ]);
      // The import's empty no longer goes back to the port; the export's empty comes from the import's consignee instead.
      for (const l of await legsOf(ctx, imp.id)) if (l.cargo === "EMPTY" && l.status === "PLANNED") await store.update("load_legs", l.id, { status: "CANCELED" }, { status: "PLANNED" });
      const emptyOut = (await legsOf(ctx, exp.id)).find((l) => l.cargo === "EMPTY" && l.status === "PLANNED");
      if (emptyOut && imp.delivery_location_id) await store.update("load_legs", emptyOut.id, { from_terminal_id: null, from_location_id: imp.delivery_location_id }, { status: "PLANNED" });
      return res.json({ import: i, export: e });
    }
    const clear = { is_street_turn: false, street_turn_pair_id: null, street_turn_status: null };
    const [i, e] = await Promise.all([store.update("loads", imp.id, clear), store.update("loads", exp.id, clear)]);
    res.json({ import: i, export: e });
  });

  return r;
}

const portUpdate = z.object({
  container_number: z.string().max(20).transform(normalizeContainerNumber),
  terminal_code: text(20).optional(),
  status: text(60).optional(),
  available: z.boolean().optional(),
  last_free_day: isoDate.nullish(),
  holds: z.array(text(60)).max(20).optional(),
  fees: z.record(z.string().max(60), z.number()).optional(),
});

const MAX_SKEW_SECONDS = 300;

/** Check `X-Onixus-Signature: hex(HMAC-SHA256(secret, "<timestamp>.<raw body>"))` within five minutes of `X-Onixus-Timestamp`. */
export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, raw: Buffer, nowMs: number): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Terminal availability feed (eModal, Advent, a terminal's own push, or an
 * n8n flow that scrapes one). Public, so it authenticates by signature.
 * Updates the container's terminal status and the last free day on every
 * open import carrying that container.
 */
export function portWebhook(ctx: Ctx) {
  return async (req: Request, res: Response) => {
    const secret = ctx.env.PORT_WEBHOOK_SECRET?.trim();
    if (!secret) throw new HttpError(503, "Port webhook is not configured: set PORT_WEBHOOK_SECRET");
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifySignature(secret, req.header("x-onixus-timestamp"), req.header("x-onixus-signature"), raw, ctx.now().getTime())) {
      throw new HttpError(401, "Bad or expired signature");
    }
    const u = portUpdate.parse(req.body);
    const problem = containerNumberProblem(u.container_number);
    if (problem) throw new HttpError(400, problem);

    const store = ctx.store();
    const terminal = u.terminal_code ? (await store.list("port_terminals", { code: u.terminal_code }, { limit: 1 }))[0] : undefined;
    const status = {
      container_number: u.container_number,
      ...(u.status !== undefined && { status: u.status }),
      ...(u.available !== undefined && { availability: u.available }),
      ...(u.last_free_day !== undefined && { last_free_day: u.last_free_day }),
      ...(u.holds !== undefined && { holds: u.holds }),
      ...(u.fees !== undefined && { fees: u.fees }),
      ...(terminal && { terminal_id: terminal.id }),
      updated_at: ctx.now().toISOString(),
    };
    const [existing] = await store.list("container_status", { container_number: u.container_number }, { limit: 1 });
    if (existing) await store.update("container_status", existing.id, status);
    else await store.insert("container_status", status);

    let loadsUpdated = 0;
    if (u.last_free_day !== undefined) {
      const loads = await store.list<Load>("loads", { container_number: u.container_number, direction: "IMPORT" });
      for (const l of loads.filter((x) => !FINISHED.includes(x.status) && !x.outgated_at && x.last_free_day !== u.last_free_day)) {
        await store.update("loads", l.id, { last_free_day: u.last_free_day, updated_at: ctx.now().toISOString() });
        loadsUpdated++;
      }
    }
    res.json({ ok: true, loads_updated: loadsUpdated });
  };
}
