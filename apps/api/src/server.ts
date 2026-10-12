import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

// One .env at the repo root serves the API, the web app and docker-compose.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const port = Number(process.env.PORT ?? 4000);
createApp(process.env).listen(port, () => console.log(`Onixus Logistics OS API on :${port}`));
