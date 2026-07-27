import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(desktopRoot, "preload", "index.ts")],
  outfile: join(desktopRoot, "dist-electron", "preload", "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
});
