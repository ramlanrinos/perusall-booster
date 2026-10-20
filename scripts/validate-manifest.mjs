// Validates dist/manifest.json: MV3, minimal permissions, and that every referenced file exists.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
const errors = [];
const fail = (msg) => errors.push(msg);

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing — run `npm run build` first.");
  process.exit(1);
}
const m = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

const ALLOWED_PERMISSIONS = new Set(["storage", "alarms", "notifications", "idle"]);
const ALLOWED_HOSTS = new Set(["https://app.perusall.com/*"]);
const FORBIDDEN_KEYS = ["content_scripts", "externally_connectable", "web_accessible_resources", "key", "update_url"];

if (m.manifest_version !== 3) fail("manifest_version must be 3");
for (const k of ["name", "version", "description"]) if (!m[k]) fail(`missing ${k}`);
if (!/^\d+(\.\d+){0,3}$/.test(m.version ?? "")) fail(`invalid version "${m.version}"`);
if ((m.description ?? "").length > 132) fail("description longer than 132 characters");

for (const p of m.permissions ?? []) if (!ALLOWED_PERMISSIONS.has(p)) fail(`permission not allowed: ${p}`);
for (const h of m.host_permissions ?? []) if (!ALLOWED_HOSTS.has(h)) fail(`host permission not allowed: ${h}`);
if (m.optional_permissions?.length || m.optional_host_permissions?.length) fail("optional permissions are not expected");
for (const k of FORBIDDEN_KEYS) if (k in m) fail(`unexpected manifest key: ${k}`);

const csp = JSON.stringify(m.content_security_policy ?? "");
if (/https?:|unsafe-eval|unsafe-inline/.test(csp)) fail("content_security_policy must not allow remote or unsafe code");

const referenced = [];
if (m.background?.service_worker) referenced.push(m.background.service_worker);
if (m.action?.default_popup) referenced.push(m.action.default_popup);
if (m.options_page) referenced.push(m.options_page);
if (m.options_ui?.page) referenced.push(m.options_ui.page);
for (const icon of Object.values(m.icons ?? {})) referenced.push(icon);
for (const icon of Object.values(m.action?.default_icon ?? {})) referenced.push(icon);
for (const file of referenced) if (!existsSync(join(dist, file))) fail(`referenced file missing in dist/: ${file}`);

// HTML pages must only load local scripts.
for (const page of referenced.filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(dist, page), "utf8");
  if (/<script[^>]+src=["']https?:/i.test(html)) fail(`${page} loads a remote script`);
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) fail(`${page} contains an inline script (blocked by MV3 CSP)`);
}

if (errors.length) {
  console.error("Manifest validation FAILED:\n - " + errors.join("\n - "));
  process.exit(1);
}
console.warn(`Manifest OK: ${m.name} ${m.version}; permissions=[${(m.permissions ?? []).join(", ")}]; hosts=[${(m.host_permissions ?? []).join(", ")}]; ${referenced.length} referenced file(s) present`);
