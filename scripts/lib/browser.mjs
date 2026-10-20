// Shared helpers for the real-browser tests: launch an isolated Chromium-based browser with the
// built extension and talk to it over the Chrome DevTools Protocol (loopback only).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser(explicit) {
  const candidates = [explicit, process.env.BROWSER, "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

/** Unpacked extension IDs are the SHA-256 of the absolute path, first 32 hex digits mapped 0-f -> a-p. */
export function unpackedExtensionId(dir) {
  return [...createHash("sha256").update(dir).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** Creates a throw-away browser profile directory (the caller deletes it with removeProfile). */
export const makeProfile = () => mkdtempSync(join(tmpdir(), "pb-browser-"));
export const removeProfile = (dir) => rmSync(dir, { recursive: true, force: true });

export async function launch({ browser, extraArgs = [], profileDir }) {
  const dist = resolve("dist");
  if (!existsSync(join(dist, "manifest.json"))) throw new Error("dist/ missing: run npm run build");
  const keepProfile = !!profileDir;
  const profile = profileDir ?? makeProfile();
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(browser, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
    "--headless=new", ...extraArgs, "about:blank",
  ], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const ctx = {
    extensionId: unpackedExtensionId(dist),
    async targets() { return (await fetch(`${base}/json/list`)).json(); },
    async version() { return (await fetch(`${base}/json/version`)).json(); },
    async close() {
      // Graceful shutdown over CDP (like a user quitting), so a reused profile is saved cleanly.
      const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
      try {
        const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
        await cdp(webSocketDebuggerUrl, "Browser.close");
      } catch { /* fall back to a signal below */ }
      const timeout = sleep(8000).then(() => "timeout");
      if ((await Promise.race([exited, timeout])) === "timeout") {
        proc.kill("SIGTERM");
        await exited;
      }
      await sleep(300);
      if (!keepProfile) removeProfile(profile);
    },
  };
  return ctx;
}

/** One CDP command over a fresh WebSocket. */
export async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const reply = new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }; });
  ws.send(JSON.stringify({ id: 1, method, params }));
  const m = await reply;
  ws.close();
  return m;
}

/** Evaluates an expression in a target and returns its JSON-serialisable value. */
export async function evaluate(wsUrl, expression) {
  const r = await cdp(wsUrl, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluation failed");
  return r.result?.result?.value;
}

export async function waitFor(fn, { tries = 40, delay = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(delay);
  }
  return undefined;
}

export function reporter() {
  const results = [];
  return {
    check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); },
    finish() {
      for (const r of results) console.warn(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
      return results.length > 0 && results.every((r) => r.ok);
    },
  };
}
