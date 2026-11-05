import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Read VITE_* variables from the repo-root .env shared with the API.
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  server: { port: 5173 },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
