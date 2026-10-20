// Production build + validation + ZIP for unpacked installation or store upload.
// Output: release/perusall-booster-<version>.zip (not committed; see .gitignore).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
run("node", ["scripts/build.mjs", "--production"]);
run("node", ["scripts/validate-manifest.mjs"]);

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
  process.exit(1);
}

const releaseDir = resolve("release");
mkdirSync(releaseDir, { recursive: true });
const zip = join(releaseDir, `perusall-booster-${manifest.version}.zip`);
rmSync(zip, { force: true });
// -X: no extra file attributes; -r: recursive; run inside dist so paths are relative.
run("zip", ["-X", "-r", "-q", zip, "."], { cwd: resolve("dist") });
const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
const forbidden = listing.filter((f) => /\.map$|\.ts$|node_modules|\.env|\.pem$/.test(f));
if (forbidden.length) {
  console.error(`Unexpected files in package: ${forbidden.join(", ")}`);
  process.exit(1);
}
console.warn(`Packaged ${listing.length} files, ${(statSync(zip).size / 1024).toFixed(1)} KiB -> ${zip}`);
