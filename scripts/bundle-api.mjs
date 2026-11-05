// Bundles the API, the @onixus/* packages (TypeScript source) and its libraries into one file the
// Vercel function loads, so nothing depends on where npm installed a package.
import { build } from "esbuild";

await build({
  entryPoints: ["apps/api/src/vercel.ts"],
  outfile: "api/_bundle/app.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Everything is bundled in (the workspace packages are TypeScript source, and some libraries are
  // installed per workspace where the function could not find them). CommonJS libraries inside an
  // ES module need require(), provided here.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "warning",
});
console.log("API bundled to api/_bundle/app.mjs");
