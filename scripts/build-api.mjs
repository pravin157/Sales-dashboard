import { build } from "esbuild";

const routes = ["status", "report", "credentials", "frejun"];

await Promise.all(
  routes.map((route) =>
    build({
      entryPoints: ["src/vercel-function.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: `api/${route}.js`,
      packages: "external",
      logLevel: "warning",
    }),
  ),
);
