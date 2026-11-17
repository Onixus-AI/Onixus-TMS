import { Router } from "express";
import { z } from "zod";
import { TRANSPORT_TYPES, quoteTotal } from "@onixus/core";
import { roles } from "../auth.js";
import { defined, HttpError, isoDate, mustGet, text, uuid, type Ctx } from "../http.js";

const UNITS = ["job", "load", "mile", "hour", "day", "pallet", "stop", "vehicle", "item"] as const;
const ruleInput = z.object({
  customer_id: uuid.nullish(),
  transport_type: z.enum(TRANSPORT_TYPES),
  description: text(200),
  unit: z.enum(UNITS),
  unit_cents: z.number().int().min(1).max(99_999_999),
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
}).strict().refine((r) => !r.effective_to || r.effective_to >= r.effective_from, "End date must follow start date");
const estimateInput = z.object({
  transport_type: z.enum(TRANSPORT_TYPES),
  customer_id: uuid.nullish(),
  quantities: z.record(uuid, z.number().positive().max(1_000_000)).optional(),
}).strict();
type Rule = z.infer<typeof ruleInput> & { id: string };

/** Customer rates replace the general template for a mode; they never leak between companies. */
export function estimateServiceRates(rules: Rule[], input: z.infer<typeof estimateInput>, day: string) {
  const current = rules.filter((r) => r.transport_type === input.transport_type
    && r.effective_from <= day && (!r.effective_to || r.effective_to >= day));
  const specific = input.customer_id ? current.filter((r) => r.customer_id === input.customer_id) : [];
  const chosen = specific.length ? specific : current.filter((r) => !r.customer_id);
  if (!chosen.length) throw new HttpError(404, `No current ${input.transport_type.toLowerCase()} rates. Add a rate rule for this company or a general rule.`);
  if (chosen.length > 50) throw new HttpError(422, "A quote supports at most 50 rate lines");
  const lines = chosen.map((r) => ({ rule_id: r.id, description: `${r.description} (per ${r.unit})`, unit: r.unit,
    quantity: input.quantities?.[r.id] ?? 1, unit_cents: r.unit_cents, periods: 1 }));
  return { method: specific.length ? "customer" : "general", lines, total_cents: quoteTotal(lines) };
}

export function pricingRoutes(ctx: Ctx) {
  const r = Router();
  r.get("/operations/rates", async (_req, res) => {
    res.json({ rules: await ctx.store().list("service_rate_rules", {}, { order: "effective_from", limit: 1000 }) });
  });
  r.post("/operations/rates", roles("OWNER"), async (req, res) => {
    const input = ruleInput.parse(req.body);
    if (input.customer_id) await mustGet(ctx, "customers", input.customer_id, "Customer");
    res.status(201).json({ rule: await ctx.store().insert("service_rate_rules", defined(input)) });
  });
  r.delete("/operations/rates/:id", roles("OWNER"), async (req, res) => {
    const rule = await mustGet(ctx, "service_rate_rules", uuid.parse(req.params.id), "Rate rule");
    await ctx.store().remove("service_rate_rules", rule.id);
    res.json({ deleted: true });
  });
  r.post("/operations/rates/estimate", async (req, res) => {
    const input = estimateInput.parse(req.body);
    if (input.customer_id) await mustGet(ctx, "customers", input.customer_id, "Customer");
    const rules = await ctx.store().list<Rule>("service_rate_rules", { transport_type: input.transport_type }, { limit: 1000 });
    res.json(estimateServiceRates(rules, input, ctx.now().toISOString().slice(0, 10)));
  });
  return r;
}
