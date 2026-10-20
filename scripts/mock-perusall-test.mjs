// Real-browser test against a LOCAL MOCK of app.perusall.com. The browser's host resolver maps
// app.perusall.com and unrelated.test to a local HTTPS server with a throw-away self-signed
// certificate, so the real Perusall site is never contacted.
// Verifies: Perusall detection, foreground accrual, tab switching/closing, isolation from unrelated
// sites, and that the extension makes no network requests of its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdp, evaluate, findBrowser, launchWithExtension, reporter, sleep, waitFor } from "./lib/browser.mjs";

const browserPath = findBrowser(process.argv[2]);
if (!browserPath) { console.error("SKIPPED: no Chromium-based browser found"); process.exit(2); }

// Throw-away certificate (deleted at the end; never written into the repository).
const certDir = mkdtempSync(join(tmpdir(), "pb-mock-cert-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.perusall.com",
  "-addext", "subjectAltName=DNS:app.perusall.com,DNS:unrelated.test",
  "-keyout", join(certDir, "k.pem"), "-out", join(certDir, "c.pem")], { stdio: "ignore" });

const requests = [];
const server = createServer({ key: readFileSync(join(certDir, "k.pem")), cert: readFileSync(join(certDir, "c.pem")) }, (req, res) => {
  requests.push({ host: req.headers.host, path: req.url, dest: req.headers["sec-fetch-dest"], origin: req.headers.origin ?? null });
  const title = req.headers.host?.startsWith("app.perusall.com") ? "Mock Perusall reading" : "Unrelated site";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>Local test page. No tracking.</p>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = reporter();
// The extension page used to message the service worker is opened in a background tab.
const { b, page: control } = await launchWithExtension({
  browser: browserPath,
  background: true,
  extraArgs: [`--host-resolver-rules=MAP app.perusall.com 127.0.0.1:${port}, MAP unrelated.test 127.0.0.1:${port}, EXCLUDE localhost`, "--ignore-certificate-errors"],
});

try {
  const worker = await waitFor(async () => (await b.targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${b.extensionId}/`)));
  check("extension loaded", worker);
  const browserWs = (await b.version()).webSocketDebuggerUrl;
  const open = async (url, background = false) => {
    const r = await cdp(browserWs, "Target.createTarget", { url, background });
    return waitFor(async () => (await b.targets()).find((t) => t.id === r.result?.targetId));
  };
  const activate = (t) => cdp(browserWs, "Target.activateTarget", { targetId: t.id });

  const unrelated = await open("https://unrelated.test/page");
  const send = (msg) => evaluate(control.webSocketDebuggerUrl, `chrome.runtime.sendMessage(${JSON.stringify(msg)}).then(r => JSON.stringify(r))`).then(JSON.parse);
  await activate(unrelated);
  await sleep(800);

  let v = (await send({ type: "getState" })).view;
  check("unrelated site: Perusall not detected", v.perusall === "none", `perusall=${v.perusall}`);

  const urls = await evaluate(worker.webSocketDebuggerUrl, "chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => t.url ?? null)))");
  check("extension cannot read unrelated tab URLs", !JSON.parse(urls).some((u) => u && u.includes("unrelated.test")), urls);

  await send({ type: "start" });
  const mock = await open("https://app.perusall.com/mock-reading");
  await activate(mock);
  await sleep(3000);
  v = (await send({ type: "getState" })).view;
  const focusedKnown = v.buckets.focusedMs > 0;
  check("mock Perusall tab detected", v.perusall === "foreground" || v.perusall === "open", `perusall=${v.perusall}`);
  check("foreground time accrues while the Perusall tab is active", focusedKnown ? v.buckets.foregroundMs >= 2000 : v.perusall === "open",
    `foreground=${v.buckets.foregroundMs}ms focused=${v.buckets.focusedMs}ms${focusedKnown ? "" : " (headless window reports no focus)"}`);
  const fgAfterMock = v.buckets.foregroundMs;

  await activate(unrelated);
  await sleep(2500);
  v = (await send({ type: "getState" })).view;
  check("switching to another tab stops Perusall foreground time", v.buckets.foregroundMs - fgAfterMock < 1000 && v.perusall === "open",
    `perusall=${v.perusall} foreground +${v.buckets.foregroundMs - fgAfterMock}ms, elapsed=${v.buckets.elapsedMs}ms`);
  check("timer elapsed keeps running independently of tabs", v.buckets.elapsedMs >= 5000, `elapsed=${v.buckets.elapsedMs}ms`);

  await cdp(browserWs, "Target.closeTarget", { targetId: mock.id });
  await sleep(1200);
  v = (await send({ type: "getState" })).view;
  check("closing the Perusall tab is detected", v.perusall === "none", `perusall=${v.perusall}`);
  await send({ type: "stop" });

  const extensionRequests = requests.filter((r) => r.origin?.startsWith("chrome-extension://") || (r.dest && r.dest !== "document" && r.path !== "/favicon.ico"));
  check("extension made no network requests", extensionRequests.length === 0, `${requests.length} page request(s): ${requests.map((r) => `${r.host}${r.path}`).join(", ")}`);
} catch (e) {
  check("mock test ran", false, String(e));
} finally {
  await b.close();
  server.close();
  rmSync(certDir, { recursive: true, force: true });
}
process.exit(finish() ? 0 : 1);
