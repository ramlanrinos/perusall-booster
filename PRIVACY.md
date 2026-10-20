# Privacy policy: Perusall Booster

_Last updated: 2026-10-20_

Perusall Booster is a personal study timer. It is designed to collect as little as possible and to keep
everything on your own device.

## What is stored

Stored only in your browser's extension storage (`chrome.storage.local`) on this device:

| Data | Purpose |
|---|---|
| Current timer state: status, start time, timestamps, the measured durations (elapsed, paused, not determined, browser focused, Perusall in foreground), and a draft note | Keep the timer correct when the popup closes or the browser restarts |
| Saved sessions: start and end time, the durations above, the number of automatic pauses, your optional note, completion status | Session history, today's total, CSV export |
| Your settings: goals, break-reminder interval, notification switches | Goals and reminders |
| The date the daily-goal reminder was last shown | Show it only once per day |

A temporary marker in `chrome.storage.session` (cleared when the browser closes) lets the extension tell that the
browser has restarted.

## What is never collected or stored

* Perusall pages' content, document names, course names, URLs or page titles.
* Annotations, comments or anything you type into Perusall.
* Cookies, passwords, login sessions or authentication tokens.
* Your browsing history or the addresses of any other website.
* Your name, email or any account identifier.

## What is never sent

**Nothing.** The extension makes no network requests: no analytics, no telemetry, no remote code, no syncing.
It doesn't talk to Perusall's servers and doesn't change anything Perusall records.

## Permissions and why

| Permission | Why |
|---|---|
| `storage` | Save the timer, history and settings on your device |
| `alarms` | A 30-second heartbeat to detect sleep and to time reminders |
| `idle` | Detect a locked screen so that time isn't counted as reading |
| `notifications` | Optional break and goal reminders (you can switch them off) |
| Access to `https://app.perusall.com/*` | Lets the browser reveal the address of the active tab **only when it is a Perusall page**, so the extension can show "Perusall in foreground". No scripts are injected and page content isn't read. |

## Your control

* **Delete** single sessions or **clear all history** on the History page.
* **Export** your history as CSV at any time.
* **Uninstalling** the extension deletes all of its stored data.
* Site access to `app.perusall.com` can be limited in the browser's extension settings. The timer keeps working,
  and only Perusall detection is disabled.

## Contact

Questions or issues: open an issue at <https://github.com/ramlanrinos/perusall-booster/issues>.
