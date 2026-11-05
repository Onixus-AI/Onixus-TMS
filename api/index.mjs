import express from "express";
import { createApp } from "./_bundle/app.mjs";

// Vercel serves the TMS web app and this API from one address: the web app calls /api/...
// It is the same Express app Railway ran (bundled at build time by scripts/bundle-api.mjs);
// the /api prefix is stripped before it routes.
const REQUIRED = ["TMS_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WEB_ORIGIN"];
const app = express();
let api = null, problem = "";
try { api = createApp(process.env); } catch (e) { problem = e instanceof Error ? e.message : "The API could not start."; }
const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
// A missing setting answers with its name (never a value) instead of crashing every request.
if (api && !missing.length) app.use("/api", api);
else app.use("/api", (_req, res) => res.status(503).json({ error: "The TMS API is not configured.", missing, detail: problem || undefined }));
export default app;
