import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Read VITE_* variables from the repo-root .env shared with the API.
export default defineConfig({ plugins: [react()], envDir: "../..", server: { port: 5173 } });
