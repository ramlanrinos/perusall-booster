// Stage-7 real-browser checks that need more than the smoke test:
//  - browser restart with the same profile: the closed period is "not determined", never elapsed
//  - CSV export produces a real download with the expected header and row
//  - "Clear all history" empties the history
// Uses only extension pages; no website is opened.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, findBrowser, launchWithExtension, makeProfile, openExtensionPage, removeProfile, reporter, sleep, waitFor } from "./lib/browser.mjs";

const browserPath = findBrowser(process.argv[2]);
if (!browserPath) { console.error("SKIPPED: no Chromium-based browser found"); process.exit(2); }
const { check, finish } = reporter();
const profile = makeProfile();
// Downloads go to a folder inside the throw-away profile, never the user's Downloads folder.
// Initial preferences are written before the browser first uses the profile.
const downloads = join(profile, "downloads-test");
mkdirSync(join(profile, "Default"), { recursive: true });
mkdirSync(downloads, { recursive: true });
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: downloads },
  // Developer mode keeps the unpacked extension enabled when the profile is reopened.
  extensions: { ui: { developer_mode: true } },
}));

const send = (page, msg) => evaluate(page.webSocketDebuggerUrl, `chrome.runtime.sendMessage(${JSON.stringify(msg)}).then(r => JSON.stringify(r))`).then(JSON.parse);

try {
  // 1) Start a session, then quit the browser.
  let { b, page } = await launchWithExtension({ browser: browserPath, profileDir: profile });
  await send(page, { type: "start" });
  await sleep(3000);
  const before = (await send(page, { type: "getState" })).view;
  await b.close();
  const closedAt = Date.now();
  await sleep(6000);

  // 2) Restart with the same profile.
  ({ b, page } = await launchWithExtension({ browser: browserPath, profileDir: profile }));
  await sleep(1000);
  const after = (await send(page, { type: "getState" })).view;
  const closedFor = Date.now() - closedAt;
  check("session survives a browser restart", after.status !== "idle" && after.startedAt === before.startedAt, `status=${after.status}`);
  check("restart auto-pauses the timer", after.status === "paused" && after.autoPauseReason === "sleep-or-closed", `${after.status}/${after.autoPauseReason}`);
  check("closed time is not counted as elapsed", after.buckets.elapsedMs < before.buckets.elapsedMs + 2500, `elapsed before=${before.buckets.elapsedMs}ms after=${after.buckets.elapsedMs}ms`);
  check("closed time is recorded as not determined", after.buckets.undeterminedMs >= 5000 && after.buckets.undeterminedMs <= closedFor + 5000,
    `not determined=${after.buckets.undeterminedMs}ms (browser closed ~${closedFor}ms)`);

  // 3) Save it and export CSV through the real UI.
  await send(page, { type: "stop", note: "=compat test, note" });
  const hist = await openExtensionPage(b, "pages/history.html");
  await evaluate(hist.webSocketDebuggerUrl, "document.getElementById('export').click()");
  const file = await waitFor(async () => { try { return readdirSync(downloads).find((f) => f.endsWith(".csv")); } catch { return undefined; } }, { tries: 30, delay: 300 });
  check("CSV export downloads a file", file, file ?? "no .csv in download folder");
  if (file) {
    const csv = readFileSync(join(downloads, file), "utf8").split("\r\n");
    check("CSV has header and one row", csv[0]?.startsWith("date,start_time,end_time,timer_elapsed_min") && csv.filter(Boolean).length === 2, `${csv.filter(Boolean).length} line(s)`);
    check("CSV neutralises a formula-like note", csv[1]?.endsWith(`"'=compat test, note"`), csv[1]);
  }

  // 4) Clear all history through the UI.
  await evaluate(hist.webSocketDebuggerUrl, "document.getElementById('clear').click()");
  await sleep(300);
  await evaluate(hist.webSocketDebuggerUrl, "document.querySelector('#confirm button[value=confirm]').click()");
  await sleep(800);
  const left = await evaluate(hist.webSocketDebuggerUrl, "document.querySelectorAll('#rows tr').length");
  const listed = (await send(page, { type: "listSessions" })).history.sessions.length;
  check("Clear all history empties the list and storage", left === 0 && listed === 0, `rows=${left} stored=${listed}`);
  await b.close();
} catch (e) {
  check("compatibility test ran", false, String(e));
} finally {
  removeProfile(profile);
}
process.exit(finish() ? 0 : 1);
