import express from "express";
import { createApp } from "./app.js";

// The API as one Vercel function (api/index.mjs loads this, bundled by scripts/bundle-api.mjs).
// Vercel serves the web app and this API from one address; the /api prefix is stripped here.
const REQUIRED = ["TMS_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WEB_ORIGIN"];

export function vercelApp(env: NodeJS.ProcessEnv = process.env) {
  const app = express();
  let api: ReturnType<typeof createApp> | null = null, problem = "";
  try { api = createApp(env); } catch (e) { problem = e instanceof Error ? e.message : "The API could not start."; }
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  // A missing setting answers with its name (never a value) instead of crashing every request.
  if (api && !missing.length) app.use("/api", api);
  else app.use("/api", (_req, res) => { res.status(503).json({ error: "The TMS API is not configured.", missing, detail: problem || undefined }); });
  return app;
}

export default vercelApp();
