// Browser smoke test: loads dist/ as an unpacked extension into a throw-away Microsoft Edge (or Chrome)
// profile, then checks that the service worker starts and the popup page renders.
// It never opens Perusall or any other website.
// Usage: node scripts/smoke-edge.mjs [/path/to/browser]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const candidates = [process.argv[2], process.env.BROWSER, "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) { console.error("SKIPPED: no Chromium-based browser found"); process.exit(2); }
const dist = resolve("dist");
if (!existsSync(join(dist, "manifest.json"))) { console.error("dist/ missing: run npm run build"); process.exit(1); }

// Unpacked extension IDs are the SHA-256 of the absolute path, first 32 hex digits mapped 0-f -> a-p.
const extensionId = [...createHash("sha256").update(dist).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const profile = mkdtempSync(join(tmpdir(), "pb-smoke-"));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(browser, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
  "--no-first-run", "--no-default-browser-check", "--disable-sync",
  `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
  "--headless=new", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); };

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const reply = new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }; });
  ws.send(JSON.stringify({ id: 1, method, params }));
  const m = await reply; ws.close(); return m;
}

try {
  let worker;
  for (let i = 0; i < 40 && !worker; i++) {
    await sleep(500);
    try { worker = (await targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`)); } catch { /* not up yet */ }
  }
  check("service worker registered", !!worker, worker ? worker.url : `no service worker for ${extensionId} (this browser build may ignore --load-extension)`);
  if (worker) {
    const id = new URL(worker.url).host;
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const created = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: `chrome-extension://${id}/popup/popup.html` });
    check("popup page opened", !!created.result?.targetId);
    let page;
    for (let i = 0; i < 20 && !page; i++) { await sleep(300); page = (await targets()).find((t) => t.id === created.result?.targetId); }
    await sleep(1500);
    const evalRes = await cdp(page.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: `JSON.stringify({title: document.title, timer: document.getElementById('timer')?.textContent, status: document.getElementById('status')?.textContent, disclaimer: !!document.getElementById('official-disclaimer'), buttons: [...document.querySelectorAll('button')].length, extra: globalThis.__pbSmoke ?? null})`,
      returnByValue: true,
    });
    const info = JSON.parse(evalRes.result?.result?.value ?? "{}");
    check("popup rendered", info.title === "Perusall Booster" && !!info.timer, JSON.stringify(info));
    check("official-records disclaimer present", info.disclaimer === true);
    const sw = await cdp(worker.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: "JSON.stringify(chrome.runtime.getManifest().permissions)", returnByValue: true,
    });
    check("service worker responsive", typeof sw.result?.result?.value === "string", `permissions=${sw.result?.result?.value}`);
  }
} catch (e) {
  check("smoke test ran", false, String(e));
} finally {
  proc.kill("SIGTERM");
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
}

for (const r of results) console.warn(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
