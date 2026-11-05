// Bundles the API (and the @onixus/* packages, which ship as TypeScript source) into one file the
// Vercel function loads. Outside packages stay external: Vercel traces them from node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["apps/api/src/app.ts"],
  outfile: "api/_bundle/app.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // Outside packages stay external (Vercel traces them); the workspace packages are TypeScript
  // source, so they are bundled in.
  plugins: [{
    name: "external-except-workspace",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@onixus/") ? undefined : { path: args.path, external: true }));
    },
  }],
  logLevel: "warning",
});
console.log("API bundled to api/_bundle/app.mjs");
