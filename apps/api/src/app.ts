import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { crmProvider, emailProvider, fmcsa, llmProvider, providerStatus, storeFromEnv, StoreError, supabaseFiles, supabaseInvite, supabaseUser, trackingProvider, type Env, type Store } from "@onixus/providers";
import { HttpError, type Ctx } from "./http.js";
import { authenticate, currentCaller, drivers, identityRoutes, platformOnly, roles, scopedFor } from "./auth.js";
import { driverRoutes } from "./routes/driver.js";
import { loadRoutes } from "./routes/loads.js";
import { fleetRoutes } from "./routes/fleet.js";
import { containerRoutes, portWebhook } from "./routes/containers.js";
import { accountRoutes, platformAccountRoutes } from "./routes/accounts.js";

// One API for every integration. Each route resolves the provider chosen in
// the environment at call time, so switching Gmail → Outlook or Claude →
// OpenAI is a config change, not a code change.

const sendEmail = z.object({ to: z.string().email(), subject: z.string().min(1).max(500), html: z.string().min(1).max(500_000), replyTo: z.string().email().optional() });
const newCompany = z.object({ name: z.string().min(1).max(300), domain: z.string().max(253).optional(), type: z.string().max(40).optional(), phone: z.string().max(40).optional() });
const newContact = z.object({ email: z.string().email(), firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(), phone: z.string().max(40).optional(), companyId: z.string().max(40).optional() });
const completion = z.object({ prompt: z.string().min(1).max(200_000), system: z.string().max(50_000).optional(), maxTokens: z.number().int().min(1).max(64_000).optional() });

/** Swap the database, clock or outside services in tests; production uses the environment. */
export type Deps = Partial<Omit<Ctx, "env" | "db" | "store" | "caller">> & { store?: () => Store };

export function createApp(env: Env, deps: Deps = {}) {
  const apiKey = env.TMS_API_KEY?.trim();
  if (!apiKey || apiKey.length < 24) throw new Error("TMS_API_KEY must be set to a random secret of at least 24 characters");
  const origins = (env.WEB_ORIGIN ?? "http://localhost:5173").split(",").map((o) => o.trim()).filter(Boolean);

  let base: Store | undefined = deps.store?.();
  const db = () => (base ??= storeFromEnv(env));
  const ctx: Ctx = {
    env,
    db,
    store: scopedFor(db),
    caller: currentCaller,
    now: deps.now ?? (() => new Date()),
    checkCarrier: deps.checkCarrier ?? ((dot) => fmcsa(env).checkCarrier(dot)),
    tracking: deps.tracking ?? (() => trackingProvider(env)),
    // Without Supabase configured no token can belong to a person.
    verifyUser: deps.verifyUser ?? (async (token) => (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? supabaseUser(env, token) : null)),
    inviteUser: deps.inviteUser ?? ((email, redirectTo) => supabaseInvite(env, email, redirectTo)),
    files: deps.files ?? (() => supabaseFiles(env)),
  };

  const app = express();
  app.disable("x-powered-by");
  // Keep the raw bytes: webhook signatures are computed over them, not over re-serialized JSON.
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => void ((req as Request & { rawBody?: Buffer }).rawBody = buf) }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-org-id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  // Signed by the sender instead of the API key (see routes/containers.ts).
  app.post("/webhooks/port", portWebhook(ctx));

  // Everything below needs a signed-in person or the platform API key (see auth.ts).
  app.use(authenticate(ctx, apiKey));

  // Anyone signed in: who am I, start a company; owners manage the team.
  app.use(identityRoutes(ctx));

  // The driver app: only the caller's own trips.
  app.use("/driver", drivers, driverRoutes(ctx));

  // Platform only: Onixus's own mailbox, CRM and AI credit, and cross-company jobs.
  app.get("/providers", platformOnly, (_req, res) => res.json({ providers: providerStatus(env) }));
  app.use(["/email", "/crm", "/llm"], platformOnly);
  app.use(["/terminals", "/fmcsa/recheck"], (req, res, next) => (req.method === "POST" ? platformOnly(req, res, next) : next()));
  app.use(platformAccountRoutes(ctx));

  app.post("/email/send", async (req, res) => {
    const message = sendEmail.parse(req.body);
    res.json(await emailProvider(env).send(message));
  });
  app.get("/email/unread", async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit);
    res.json({ messages: await emailProvider(env).listUnread(limit) });
  });

  app.get("/crm/companies", async (req, res) => {
    const q = z.string().min(1).max(200).parse(req.query.q);
    res.json({ companies: await crmProvider(env).searchCompanies(q, 20) });
  });
  app.post("/crm/companies", async (req, res) => {
    const company = newCompany.parse(req.body);
    res.status(201).json(await crmProvider(env).createCompany(company));
  });
  app.post("/crm/contacts", async (req, res) => {
    const contact = newContact.parse(req.body);
    res.status(201).json(await crmProvider(env).createContact(contact));
  });

  app.post("/llm/complete", async (req, res) => {
    const request = completion.parse(req.body);
    const llm = llmProvider(env);
    res.json({ provider: llm.name, ...(await llm.complete(request)) });
  });

  // The office: owners and dispatchers (or the platform acting inside a company).
  app.use(roles("OWNER", "DISPATCHER"));
  app.use(loadRoutes(ctx), fleetRoutes(ctx), containerRoutes(ctx), accountRoutes(ctx));

  // Live positions of this company's trucks. The GPS server is shared, so
  // trackers no truck of this company claims are never shown.
  app.get("/tracking", async (_req, res) => {
    const [positions, trucks] = await Promise.all([ctx.tracking().positions(), ctx.store().list("trucks", {}, { limit: 1000 })]);
    const byDevice = new Map(trucks.filter((t) => t.tracking_device_id).map((t) => [t.tracking_device_id as string, t]));
    res.json({ vehicles: positions.filter((p) => byDevice.has(p.deviceId)).map((p) => ({ ...p, truck: byDevice.get(p.deviceId) })) });
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  // Express 5 routes rejected promises from async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
    if (err instanceof HttpError || err instanceof StoreError) {
      return res.status(err.status).json({ error: err.message, ...(err instanceof HttpError && err.problems ? { problems: err.problems } : {}) });
    }
    const e = err as { status?: number; message?: string; missing?: string[] };
    const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500 && status !== 501 && status !== 503) console.error(err);
    res.status(status).json({ error: status === 500 ? "Internal error" : e.message, ...(e.missing ? { missing: e.missing } : {}) });
  });
  return app;
}
