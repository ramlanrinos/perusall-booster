// Browser smoke test: loads dist/ into a throw-away Microsoft Edge (or Chrome) profile, checks that
// the service worker starts, then drives the real popup and history page. Never opens any website.
// Usage: node scripts/smoke-edge.mjs [/path/to/browser]
import { cdp, evaluate, findBrowser, launch, reporter, sleep, waitFor } from "./lib/browser.mjs";

const browserPath = findBrowser(process.argv[2]);
if (!browserPath) { console.error("SKIPPED: no Chromium-based browser found"); process.exit(2); }

const { check, finish } = reporter();
const b = await launch({ browser: browserPath });
try {
  const worker = await waitFor(async () => (await b.targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${b.extensionId}/`)));
  check("service worker registered", worker, worker ? worker.url : `no service worker for ${b.extensionId} (this browser build may ignore --load-extension)`);
  if (worker) {
    const created = await cdp((await b.version()).webSocketDebuggerUrl, "Target.createTarget", { url: `chrome-extension://${b.extensionId}/popup/popup.html` });
    const page = await waitFor(async () => (await b.targets()).find((t) => t.id === created.result?.targetId));
    check("popup page opened", page);
    await sleep(1500);
    const run = (expr) => evaluate(page.webSocketDebuggerUrl, expr);
    const info = JSON.parse(await run(`JSON.stringify({title: document.title, timer: document.getElementById('timer')?.textContent, status: document.getElementById('status')?.textContent, disclaimer: !!document.getElementById('official-disclaimer'), buttons: document.querySelectorAll('button').length})`));
    check("popup rendered", info.title === "Perusall Booster" && info.timer, JSON.stringify(info));
    check("official-records disclaimer present", info.disclaimer === true);

    const state = async () => JSON.parse(await run(`JSON.stringify({status: document.getElementById('status').dataset.status, timer: document.getElementById('timer').textContent})`));
    await run("document.getElementById('btn-start').click()");
    await sleep(2600);
    const running = await state();
    check("Start runs the timer", running.status === "running" && running.timer !== "0:00:00", JSON.stringify(running));
    await run("document.getElementById('btn-pause').click()");
    await sleep(800);
    const paused = await state();
    await sleep(1500);
    const pausedLater = await state();
    check("Pause freezes the timer", paused.status === "paused" && paused.timer === pausedLater.timer, `${JSON.stringify(paused)} -> ${JSON.stringify(pausedLater)}`);
    await run("location.reload()");
    await sleep(1500);
    const reopened = await state();
    check("Reopening the popup keeps the session", reopened.status === "paused" && reopened.timer === paused.timer, JSON.stringify(reopened));
    await run("document.getElementById('btn-stop').click()");
    await sleep(800);
    const stopped = await state();
    check("Stop ends the session", stopped.status === "idle", JSON.stringify(stopped));

    await run(`location.href = chrome.runtime.getURL("pages/history.html")`);
    await sleep(1500);
    const hist = JSON.parse(await run(`JSON.stringify({rows: document.querySelectorAll('#rows tr').length, exportEnabled: !document.getElementById('export').disabled, count: document.getElementById('sum-count').textContent})`));
    check("History lists the saved session", hist.rows === 1 && hist.exportEnabled && hist.count === "1", JSON.stringify(hist));

    const perms = await evaluate(worker.webSocketDebuggerUrl, "JSON.stringify(chrome.runtime.getManifest().permissions)");
    check("service worker responsive", typeof perms === "string", `permissions=${perms}`);
  }
} catch (e) {
  check("smoke test ran", false, String(e));
} finally {
  await b.close();
}
process.exit(finish() ? 0 : 1);
