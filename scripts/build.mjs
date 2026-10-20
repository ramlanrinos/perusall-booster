// Bundles the extension into dist/ (load this folder as an unpacked extension).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const production = process.argv.includes("--production");

// entry (relative to src/) -> output file (relative to dist/)
const entries = {
  "background/index.ts": "background.js",
  "popup/popup.ts": "popup/popup.js",
  "pages/history.ts": "pages/history.js",
  "pages/options.ts": "pages/options.js",
};

// static files copied as-is (relative to repo root -> dist/)
const statics = [
  ["manifest.json", "manifest.json"],
  ["icons", "icons"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/pages/history.html", "pages/history.html"],
  ["src/pages/options.html", "pages/options.html"],
  ["src/pages/pages.css", "pages/pages.css"],
  ["src/styles", "styles"],
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entryPoints = Object.entries(entries)
  .filter(([src]) => existsSync(join(root, "src", src)))
  .map(([src, out]) => ({ in: join(root, "src", src), out: out.replace(/\.js$/, "") }));

await build({
  entryPoints,
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: production ? false : "linked",
  minify: production,
  legalComments: "none",
  logLevel: "warning",
});

for (const [from, to] of statics) {
  const src = join(root, from);
  if (existsSync(src)) cpSync(src, join(dist, to), { recursive: true });
}

console.warn(`Built ${entryPoints.length} script(s) into dist/${production ? " (production)" : ""}`);
