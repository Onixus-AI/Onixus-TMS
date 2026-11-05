import express from "express";
import { createApp } from "./_bundle/app.mjs";

// Vercel serves the TMS web app and this API from one address: the web app calls /api/...
// It is the same Express app Railway ran (bundled at build time by scripts/bundle-api.mjs);
// the /api prefix is stripped before it routes.
const app = express();
app.use("/api", createApp(process.env));
export default app;
