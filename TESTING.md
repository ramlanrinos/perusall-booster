# Testing

## How to run

```bash
npm install
npm run check            # typecheck, lint, unit/integration tests, build, manifest validation, secret scan
npm run check:history    # secret / personal-data scan over the full Git history
npm run test:browser     # real-browser tests (needs Microsoft Edge, Google Chrome or Chromium)
```

`npm run test:browser` runs three scripts. Each one starts a **headless browser with a throw-away profile**
(deleted afterwards), loads `dist/` as an unpacked extension, and drives it through the Chrome DevTools Protocol on
`127.0.0.1`. A different browser can be passed explicitly, for example
`node scripts/smoke-edge.mjs /usr/bin/google-chrome`.

| Script | What it covers |
|---|---|
| `scripts/smoke-edge.mjs` | Service worker starts; popup renders within 600 px; Start / Pause / reopen / Stop; reset dialog (cancel and confirm); note saved; history lists and deletes; options validation and persistence |
| `scripts/mock-perusall-test.mjs` | **Local mock of `app.perusall.com`**: the browser's host resolver maps it to a local HTTPS server with a throw-away certificate, so the real Perusall is never contacted. Checks detection, foreground time, tab switch and close, isolation from an unrelated site, and that the extension sends no network requests |
| `scripts/compat-test.mjs` | Browser quit and restart with the same profile; real CSV download; clear-all history |

## Stage 7 results (Microsoft Edge 153.0.4234.32, Linux, headless)

| # | Scenario | How it was tested | Result |
|---|---|---|---|
| 1 | Starting a session | unit + Edge (smoke) | Pass |
| 2 | Pausing and resuming | unit + Edge (smoke) | Pass |
| 3 | Stopping and saving | unit + Edge (smoke, history shows the session and note) | Pass |
| 4 | Resetting the timer | unit + Edge (dialog: cancel keeps, confirm discards, nothing saved) | Pass |
| 5 | Closing and reopening the popup | unit (repeated `getState` never double counts) + Edge (reload keeps paused time) | Pass |
| 6 | Browser restart and state recovery | unit + Edge (quit, wait about 9 s, relaunch the same profile: session kept, auto-paused, closed time counted as *not determined*, not elapsed) | Pass. Found and fixed a startup race, see below |
| 7 | Foreground-tab changes | unit + Edge with the local mock page | Pass |
| 8 | Browser sleep / device suspension | **Simulated only**: unit tests feed heartbeat gaps (> 90 s) and a backwards clock. A real OS suspend could not be triggered in this environment | Pass (simulated); real suspend **not verified** |
| 9 | Duplicate time counting | unit (same-instant observations, concurrent and double-clicked commands, popup reopen) | Pass |
| 10 | Missing permissions | unit (site access withheld means "not detectable" and never counted; API failures fall back to safe values). Revoking site access in a real browser was not automated | Pass (unit); real revocation **not verified** |
| 11 | Storage errors | unit (write failure leaves state unchanged and reports it; failed history save keeps the session running; corrupt data is backed up and reset) | Pass |
| 12 | Clearing history | unit + Edge (confirm dialog, list and storage empty) | Pass |
| 13 | CSV export | unit (RFC 4180 quoting, formula neutralising) + Edge (real download into the throw-away profile, header + row checked) | Pass |
| 14 | Google Chrome compatibility | **Not tested**: Google Chrome and Chromium are not installed on the development machine. The extension uses only standard MV3 APIs (`storage`, `alarms`, `idle`, `notifications`, `tabs.query`, `windows`) available since Chrome 116, which is the `minimum_chrome_version` | **Not verified** |
| 15 | Microsoft Edge compatibility | all three browser scripts | Pass |
| 16 | Isolation from unrelated websites | Edge mock test: unrelated tab URLs are invisible to the extension; no content scripts; no requests from the extension | Pass |
| 17 | No secrets / private data in the repository | `npm run check:secrets` (tracked + staged files) and `npm run check:history` (every line ever committed) | Pass |

Additional checks: WCAG AA contrast for all text colour pairs in light and dark themes (unit test); no `innerHTML`,
`eval` or `new Function` in `src/`; `npm audit` reported 0 vulnerabilities.

### Issues found and fixed by testing

* **Startup race:** a session left running when the browser was closed for less than 90 s could count the closed time
  as reading time, because the context refresh at worker start could run before `runtime.onStartup`. The first
  observation of every browser session is now detected with a `chrome.storage.session` marker.
* **Popup too tall** (847 px, over the 600 px popup limit); now 587 px.
* **Hidden buttons visible:** `.btn { display }` overrode the `hidden` attribute.
* **Session note could be lost** when the periodic re-render replaced an unsent edit.

### Known test-harness limitation

Edge occasionally doesn't re-register a command-line (`--load-extension`) extension when a test profile is reopened.
`compat-test.mjs` retries the relaunch once and prints a note when it does. This affects only the test harness, not
installed extensions.
