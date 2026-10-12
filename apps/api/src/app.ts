import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { crmProvider, emailProvider, llmProvider, providerStatus, type Env } from "@onixus/providers";

// One API for every integration. Each route resolves the provider chosen in
// the environment at call time, so switching Gmail → Outlook or Claude →
// OpenAI is a config change, not a code change.

const sendEmail = z.object({ to: z.string().email(), subject: z.string().min(1).max(500), html: z.string().min(1).max(500_000), replyTo: z.string().email().optional() });
const newCompany = z.object({ name: z.string().min(1).max(300), domain: z.string().max(253).optional(), type: z.string().max(40).optional(), phone: z.string().max(40).optional() });
const newContact = z.object({ email: z.string().email(), firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(), phone: z.string().max(40).optional(), companyId: z.string().max(40).optional() });
const completion = z.object({ prompt: z.string().min(1).max(200_000), system: z.string().max(50_000).optional(), maxTokens: z.number().int().min(1).max(64_000).optional() });

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(env: Env) {
  const apiKey = env.TMS_API_KEY?.trim();
  if (!apiKey || apiKey.length < 24) throw new Error("TMS_API_KEY must be set to a random secret of at least 24 characters");
  const origins = (env.WEB_ORIGIN ?? "http://localhost:5173").split(",").map((o) => o.trim()).filter(Boolean);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Everything below needs the API key: these routes send mail as the
  // business, write to the CRM and spend LLM credit.
  app.use((req, res, next) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token || !sameSecret(token, apiKey)) return res.status(401).json({ error: "Valid API key required" });
    next();
  });

  app.get("/providers", (_req, res) => res.json({ providers: providerStatus(env) }));

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

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  // Express 5 routes rejected promises from async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
    const e = err as { status?: number; message?: string; missing?: string[] };
    const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500 && status !== 501 && status !== 503) console.error(err);
    res.status(status).json({ error: status === 500 ? "Internal error" : e.message, ...(e.missing ? { missing: e.missing } : {}) });
  });
  return app;
}
