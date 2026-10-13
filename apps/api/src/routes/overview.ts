import { Router } from "express";
import { z } from "zod";
import { containerRisk, DEFAULT_RATE_CARD, needsEmpty, rateCard, suggestedCharges, type RateCard } from "@onixus/core";
import { HttpError, mustGet, type Ctx } from "../http.js";
import { legsOf, type Leg } from "./legs.js";
import type { Load } from "./loads.js";

// The office dashboard, the company's rate card for drayage extras, and the
// extras a load has earned. Everything is computed from loads and legs the
// app already records; nothing here calls an outside service.

const DAY = 86_400_000;
const dateOf = (iso: string) => iso.slice(0, 10);

function orgIdOf(ctx: Ctx): string {
  const c = ctx.caller();
  const id = c?.kind === "system" ? c.orgId : c?.member?.org_id;
  if (!id) throw new HttpError(403, "Join or create a company first");
  return id;
}

export async function rateCardOf(ctx: Ctx): Promise<RateCard> {
  const org = await ctx.db().get<{ id: string; rate_card?: Record<string, unknown> | null }>("organizations", orgIdOf(ctx));
  return rateCard(org?.rate_card);
}

/** The extras this load has earned so far, priced from the company's rate card. */
export async function extrasFor(ctx: Ctx, load: Load, legs?: Leg[]) {
  return suggestedCharges(load, legs ?? (await legsOf(ctx, load.id)), await rateCardOf(ctx), ctx.now());
}

const OPEN = ["BOOKED", "PLANNED", "ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED", "ON_HOLD"] as const;
const WAITING = new Set(["BOOKED", "PLANNED"]);
const ROLLING = new Set(["ASSIGNED", "DISPATCHED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT"]);
const READY = new Set(["DELIVERED", "POD_RECEIVED"]);
const MOVING = new Set(["AT_ORIGIN", "IN_TRANSIT", "AT_DESTINATION"]);
const RISK_ORDER = { ACCRUING: 0, URGENT: 1, WATCH: 2, NONE: 3 } as const;

/** A container still in play: its clocks have not both stopped. */
const containerOpen = (l: Load) => l.equipment_type === "CONTAINER" && !(l.direction === "IMPORT" ? l.empty_returned_at : l.ingated_at) && l.status !== "ON_HOLD";

/** The dashboard numbers for the caller's company. */
export async function overviewData(ctx: Ctx, days: 7 | 30) {
  const store = ctx.store();
  const now = ctx.now();
  const todayDate = dateOf(now.toISOString());
  const yesterday = dateOf(new Date(now.getTime() - DAY).toISOString());

  const [loads, openLegs, doneLegs] = await Promise.all([
    store.list<Load>("loads", { status: [...OPEN] }, { order: "created_at", limit: 2000 }),
    store.list<Leg>("load_legs", { status: ["PLANNED", "ASSIGNED", "DISPATCHED", "AT_ORIGIN", "IN_TRANSIT", "AT_DESTINATION"] }, { limit: 2000 }),
    store.list<Leg>("load_legs", { status: "DONE" }, { order: "done_at", limit: 3000 }),
  ]);
  const byId = new Map(loads.map((l) => [l.id, l]));
  const live = (l: Leg) => {
    const load = byId.get(l.load_id);
    return !!load && load.status !== "ON_HOLD";
  };

  // Moves per day: loaded and empty legs finished.
  const since = dateOf(new Date(now.getTime() - (days - 1) * DAY).toISOString());
  const series = Array.from({ length: days }, (_, i) => ({ date: dateOf(new Date(now.getTime() - (days - 1 - i) * DAY).toISOString()), loaded: 0, empty: 0 }));
  const slot = new Map(series.map((s) => [s.date, s]));
  for (const l of doneLegs) {
    if (!l.done_at || dateOf(l.done_at) < since) continue;
    const s = slot.get(dateOf(l.done_at));
    if (s) s[l.cargo === "LOADED" ? "loaded" : "empty"]++;
  }
  const doneOn = (d: string) => doneLegs.filter((l) => l.done_at && dateOf(l.done_at) === d).length;

  // Containers: clocks, money and where each box is.
  const containers = loads.filter(containerOpen);
  const legsByLoad = new Map<string, Leg[]>();
  for (const l of openLegs) legsByLoad.set(l.load_id, [...(legsByLoad.get(l.load_id) ?? []), l]);
  const risks = containers.map((load) => ({ load, risk: containerRisk(load, now) }));
  const accruing = risks.filter((x) => x.risk.level === "ACCRUING");
  const where = { terminal: 0, road: 0, yard: 0, customer: 0 };
  for (const load of containers) {
    const legs = legsByLoad.get(load.id) ?? [];
    if (legs.some((l) => MOVING.has(l.status))) where.road++;
    else if (!load.outgated_at) where.terminal++; // import not picked up yet; export empty not pulled yet
    else if (load.direction === "IMPORT" && load.yard_location_id && ["PICKED_UP", "IN_TRANSIT"].includes(load.status)) where.yard++;
    else where.customer++;
  }

  const planned = openLegs.filter((l) => l.status === "PLANNED" && live(l));
  const urgentIds = new Set(risks.filter((x) => x.risk.level === "URGENT" || x.risk.level === "ACCRUING").map((x) => x.load.id));
  const ready = loads.filter((l) => READY.has(l.status));
  const customerIds = [...new Set(risks.map((x) => x.load.customer_id).filter((x): x is string => !!x))];
  const customers = customerIds.length ? await store.list<{ id: string; company_name: string }>("customers", { id: customerIds }, { limit: 500 }) : [];
  const customerName = new Map(customers.map((c) => [c.id, c.company_name]));

  return {
    as_of: now.toISOString(),
    pipeline: {
      waiting: loads.filter((l) => WAITING.has(l.status)).length,
      rolling: loads.filter((l) => ROLLING.has(l.status)).length,
      at_customer: loads.filter((l) => l.status === "AT_DELIVERY").length,
      to_invoice: ready.length,
    },
    kpis: {
      containers: containers.length,
      at_risk: { amount: accruing.reduce((s, x) => s + x.risk.demurrage + x.risk.perDiem, 0), containers: accruing.length },
      moves_today: doneOn(todayDate),
      moves_yesterday: doneOn(yesterday),
      ready_to_invoice: { count: ready.length, amount: ready.reduce((s, l) => s + (Number(l.rate) || 0), 0) },
    },
    queue: {
      legs_waiting: planned.length,
      at_terminal: where.terminal,
      at_customer: where.customer,
      empties_to_return: containers.filter((l) => l.direction === "IMPORT" && l.outgated_at && !l.empty_returned_at && ["AT_DELIVERY", "DELIVERED", "POD_RECEIVED", "INVOICED"].includes(l.status)).length,
      exports_need_empty: loads.filter(needsEmpty).length,
    },
    needs_truck: {
      legs: planned.length,
      urgent: planned.filter((l) => urgentIds.has(l.load_id)).length,
      appointment_today: planned.filter((l) => l.appointment_at && dateOf(l.appointment_at) === todayDate).length,
    },
    where,
    series,
    attention: risks
      .filter((x) => x.risk.level !== "NONE")
      .sort((a, b) => RISK_ORDER[a.risk.level] - RISK_ORDER[b.risk.level] || b.risk.demurrage + b.risk.perDiem - (a.risk.demurrage + a.risk.perDiem))
      .slice(0, 8)
      .map(({ load, risk }) => ({
        load_id: load.id,
        load_number: load.load_number ?? null,
        container_number: load.container_number ?? null,
        customer: load.customer_id ? customerName.get(load.customer_id) ?? null : null,
        level: risk.level,
        reason: risk.reason,
        amount: risk.demurrage + risk.perDiem,
        last_free_day: load.last_free_day ?? null,
      })),
  };
}

export function overviewRoutes(ctx: Ctx) {
  const r = Router();

  r.get("/overview", async (req, res) => {
    const { days } = z.object({ days: z.coerce.number().int().refine((d) => d === 7 || d === 30).default(30) }).parse(req.query);
    res.json(await overviewData(ctx, days as 7 | 30));
  });

  r.get("/rate-card", async (_req, res) => {
    res.json({ rate_card: await rateCardOf(ctx), defaults: DEFAULT_RATE_CARD });
  });

  r.put("/rate-card", async (req, res) => {
    const c = ctx.caller();
    if (c?.kind === "user" && c.member?.role !== "OWNER") throw new HttpError(403, "Only an owner can change prices");
    const n = z.number().nonnegative().max(100_000);
    const body = z.object(Object.fromEntries(Object.keys(DEFAULT_RATE_CARD).map((k) => [k, n.optional()]))).strict().parse(req.body);
    const merged = { ...(await rateCardOf(ctx)), ...body };
    await ctx.db().update("organizations", orgIdOf(ctx), { rate_card: merged });
    res.json({ rate_card: merged });
  });

  r.get("/loads/:id/extras", async (req, res) => {
    const load = await mustGet<Load>(ctx, "loads", req.params.id, "Load");
    res.json({ extras: await extrasFor(ctx, load) });
  });

  return r;
}
