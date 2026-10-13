import { Router } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LOAD_STATUSES, normalizeContainerNumber } from "@onixus/core";
import { HttpError, mustGet, uuid, type Ctx } from "../http.js";
import { commsFor, draftRequest, emailHtml } from "./comms.js";
import { legsOf, placesFor } from "./legs.js";
import { charges, type Load } from "./loads.js";
import { extrasFor, overviewData } from "./overview.js";

// Onixus Dispatcher as an MCP server, for Onyx (or any MCP client) to work
// alongside Onyx Mail and Onyx CRM. It sits behind the same sign-in as the
// office: a dispatcher's or owner's token, or the platform key with
// X-Org-Id, so every tool sees one company's data and nothing else. The
// tools run the same code as the office screens, with the same rules.

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });

async function findLoad(ctx: Ctx, ref: string): Promise<Load> {
  const raw = ref.trim();
  if (uuid.safeParse(raw).success) return mustGet<Load>(ctx, "loads", raw, "Load");
  const store = ctx.store();
  const [byNumber] = await store.list<Load>("loads", { load_number: raw.toUpperCase() }, { limit: 1 });
  if (byNumber) return byNumber;
  const [byContainer] = await store.list<Load>("loads", { container_number: normalizeContainerNumber(raw) }, { order: "created_at", limit: 1 });
  if (byContainer) return byContainer;
  throw new HttpError(404, `No load or container matches ${raw}`);
}

function server(ctx: Ctx) {
  const comms = commsFor(ctx);
  const mcp = new McpServer({ name: "onixus-dispatcher", version: "1.0.0" });
  // Errors come back as tool errors the agent can read, not as transport failures.
  const tool = <T>(fn: (args: T) => Promise<unknown>) => async (args: T) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return { ...json({ error: e instanceof Error ? e.message : String(e), problems: e instanceof HttpError ? e.problems : undefined }), isError: true };
    }
  };

  mcp.registerTool("get_overview", {
    title: "Company overview",
    description: "The dispatch office dashboard: loads by stage, containers in play, demurrage and per diem running, moves per day, legs without a truck, and the containers that need attention.",
    inputSchema: { days: z.union([z.literal(7), z.literal(30)]).default(7).describe("Days of moves history") },
    annotations: { readOnlyHint: true },
  }, tool(({ days }: { days: 7 | 30 }) => overviewData(ctx, days)));

  mcp.registerTool("search_loads", {
    title: "Search loads",
    description: "Open loads, optionally filtered by text (load number, container, booking, B/L, customer) and status. Includes each container's clock risk.",
    inputSchema: { query: z.string().max(100).optional(), status: z.enum(LOAD_STATUSES).optional() },
    annotations: { readOnlyHint: true },
  }, tool(async ({ query, status }: { query?: string; status?: string }) => {
    const { open_loads } = await comms.snapshot();
    const q = query?.toLowerCase().replace(/\s/g, "");
    return open_loads.filter((l) => (!status || l.status === status) && (!q || JSON.stringify(l).toLowerCase().replace(/\s/g, "").includes(q))).slice(0, 50);
  }));

  mcp.registerTool("get_load", {
    title: "Load details",
    description: "One load by id, load number or container number: its fields, legs with places, container clocks, the extras it has earned, and the emails sent about it.",
    inputSchema: { load: z.string().min(1).max(60) },
    annotations: { readOnlyHint: true },
  }, tool(async ({ load: ref }: { load: string }) => {
    const load = await findLoad(ctx, ref);
    const legs = (await legsOf(ctx, load.id)).filter((l) => l.status !== "CANCELED");
    const [places, extras, emails] = await Promise.all([placesFor(ctx, legs), extrasFor(ctx, load, legs), ctx.store().list("email_log", { load_id: load.id }, { order: "created_at", limit: 20 })]);
    return { load, legs, places, clocks: charges(load, ctx.now()), extras, emails };
  }));

  mcp.registerTool("draft_customer_email", {
    title: "Draft a customer email",
    description: "Draft (not send) an email to the load's customer from the facts on the load. Purposes: STATUS_UPDATE, DELIVERED, APPOINTMENT, LFD_WARNING, PER_DIEM, INVOICE.",
    inputSchema: { load: z.string().min(1).max(60), purpose: draftRequest.shape.purpose, note: z.string().max(1000).optional() },
    annotations: { readOnlyHint: true },
  }, tool(async ({ load: ref, purpose, note }: { load: string; purpose: z.infer<typeof draftRequest>["purpose"]; note?: string }) => {
    const load = await findLoad(ctx, ref);
    return comms.draftEmail({ load_id: load.id, purpose, note });
  }));

  mcp.registerTool("send_email", {
    title: "Send an email",
    description: "Send an email from the company (through its connected mailbox) and log it on the load. Replies go to the person the token belongs to.",
    inputSchema: { to: z.string().email(), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000), load: z.string().max(60).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, tool(async ({ to, subject, body, load: ref }: { to: string; subject: string; body: string; load?: string }) => {
    const load = ref ? await findLoad(ctx, ref) : null;
    const company = await comms.orgName(comms.caller().orgId);
    return comms.send({ to: to.toLowerCase(), subject, body, html: emailHtml(body, company), load_id: load?.id ?? null });
  }));

  return mcp;
}

export function mcpRoutes(ctx: Ctx) {
  const r = Router();
  // Stateless: each request gets its own server, already scoped to the caller's company.
  r.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const mcp = server(ctx);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  r.all("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP requests" }));
  return r;
}
