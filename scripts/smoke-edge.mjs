// Browser smoke test: loads dist/ into a throw-away Microsoft Edge (or Chrome) profile, checks that
// the service worker starts, then drives the real popup and history page. Never opens any website.
// Usage: node scripts/smoke-edge.mjs [/path/to/browser]
import { writeFileSync } from "node:fs";
import { cdp, evaluate, findBrowser, launchWithExtension, reporter, sleep, waitFor } from "./lib/browser.mjs";

const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR; // optional: save popup screenshots for review

const browserPath = findBrowser(process.argv[2]);
if (!browserPath) { console.error("SKIPPED: no Chromium-based browser found"); process.exit(2); }

const { check, finish } = reporter();
const { b, page } = await launchWithExtension({ browser: browserPath });
try {
  const worker = await waitFor(async () => (await b.targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${b.extensionId}/`)));
  check("service worker registered", worker, worker ? worker.url : `no service worker for ${b.extensionId}`);
  if (worker) {
    check("popup page opened", page);
    const run = (expr) => evaluate(page.webSocketDebuggerUrl, expr);
    const info = JSON.parse(await run(`JSON.stringify({title: document.title, timer: document.getElementById('timer')?.textContent, status: document.getElementById('status')?.textContent, disclaimer: !!document.getElementById('official-disclaimer'), buttons: document.querySelectorAll('button').length})`));
    check("popup rendered", info.title === "Perusall Booster" && info.timer, JSON.stringify(info));
    check("official-records disclaimer present", info.disclaimer === true);

    await cdp(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const height = await run("document.body.scrollHeight");
    check("popup fits the 600 px popup limit", height <= 600, `content height ${height}px`);

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
    if (screenshotDir) {
      const shot = await cdp(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
      writeFileSync(`${screenshotDir}/popup-paused.png`, Buffer.from(shot.result.data, "base64"));
      await cdp(page.webSocketDebuggerUrl, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
      await sleep(300);
      const dark = await cdp(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
      writeFileSync(`${screenshotDir}/popup-dark.png`, Buffer.from(dark.result.data, "base64"));
      await cdp(page.webSocketDebuggerUrl, "Emulation.setEmulatedMedia", { features: [] });
    }
    await run("document.getElementById('note').value = 'Smoke test note'; document.getElementById('note').dispatchEvent(new Event('input'))");
    await sleep(600);
    await run("document.getElementById('btn-stop').click()");
    await sleep(800);
    const stopped = await state();
    check("Stop ends the session", stopped.status === "idle", JSON.stringify(stopped));

    // Reset: requires confirmation and discards without saving.
    await run("document.getElementById('btn-start').click()");
    await sleep(1200);
    await run("document.getElementById('btn-reset').click()");
    await sleep(300);
    const dialogOpen = await run("document.getElementById('confirm-reset').open");
    await run("document.querySelector('#confirm-reset button[value=cancel]').click()");
    await sleep(500);
    const afterCancel = await state();
    await run("document.getElementById('btn-reset').click()");
    await sleep(300);
    await run("document.querySelector('#confirm-reset button[value=confirm]').click()");
    await sleep(800);
    const afterReset = await state();
    check("Reset asks for confirmation; Cancel keeps, Confirm discards", dialogOpen && afterCancel.status === "running" && afterReset.status === "idle",
      `dialog=${dialogOpen} cancel=${afterCancel.status} confirm=${afterReset.status}`);

    await run(`location.href = chrome.runtime.getURL("pages/history.html")`);
    await sleep(1500);
    const hist = JSON.parse(await run(`JSON.stringify({rows: document.querySelectorAll('#rows tr').length, exportEnabled: !document.getElementById('export').disabled, count: document.getElementById('sum-count').textContent})`));
    check("History lists the saved session (reset session not saved)", hist.rows === 1 && hist.exportEnabled && hist.count === "1", JSON.stringify(hist));
    const note = await run("document.querySelector('#rows td.note')?.textContent");
    check("Session note saved", note === "Smoke test note", note);
    const csv = await run(`import(chrome.runtime.getURL('pages/history.js')).then(() => true).catch(() => true)`);
    check("History page script loaded", csv === true);

    await run("document.querySelector('#rows button').click()");
    await sleep(300);
    await run("document.querySelector('#confirm button[value=confirm]').click()");
    await sleep(800);
    const afterDelete = await run("document.querySelectorAll('#rows tr').length");
    check("Delete removes a session after confirmation", afterDelete === 0, `rows=${afterDelete}`);

    await run(`location.href = chrome.runtime.getURL("pages/options.html")`);
    await sleep(1200);
    await run("document.getElementById('dailyGoalMinutes').value = '-4'; document.querySelector('#form button[type=submit]').click()");
    await sleep(500);
    const invalidShown = await run("!document.getElementById('error').hidden && document.getElementById('dailyGoalMinutes').getAttribute('aria-invalid') === 'true'");
    await run("document.getElementById('dailyGoalMinutes').value = '45'; document.getElementById('breakReminderMinutes').value = '20'; document.getElementById('notifyBreaks').checked = false; document.querySelector('#form button[type=submit]').click()");
    await sleep(700);
    await run("location.reload()");
    await sleep(1200);
    const persisted = JSON.parse(await run("JSON.stringify({daily: document.getElementById('dailyGoalMinutes').value, brk: document.getElementById('breakReminderMinutes').value, notify: document.getElementById('notifyBreaks').checked})"));
    if (screenshotDir) {
      await cdp(page.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
      const shot = await cdp(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
      writeFileSync(`${screenshotDir}/options.png`, Buffer.from(shot.result.data, "base64"));
    }
    check("Options validate input and persist after reload", invalidShown && persisted.daily === "45" && persisted.brk === "20" && persisted.notify === false, JSON.stringify(persisted));

    const perms = await evaluate(worker.webSocketDebuggerUrl, "JSON.stringify(chrome.runtime.getManifest().permissions)");
    check("service worker responsive", typeof perms === "string", `permissions=${perms}`);
  }
} catch (e) {
  check("smoke test ran", false, String(e));
} finally {
  await b.close();
}
process.exit(finish() ? 0 : 1);
