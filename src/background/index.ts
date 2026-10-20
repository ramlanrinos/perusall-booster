// Perusall Booster service worker: owns the personal timer and answers popup requests.
// It never contacts Perusall or any other server, and injects nothing into web pages.
import {
  isHistoryRequest, isRequest, isSettingsRequest, type HistoryResponse, type Response, type SettingsResponse,
} from "../shared/messages";
import { PERUSALL_MATCH } from "../shared/perusall";
import { readActivity, type ActivityApis } from "./activity";
import { BackgroundService, HEARTBEAT_ALARM } from "./service";
import { Store } from "./storage";

const service = new BackgroundService({
  store: new Store(chrome.storage.local),
  alarms: chrome.alarms,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
  notify: async (r) => {
    await chrome.notifications.create(`pb-${r.kind}-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: r.title,
      message: r.message,
      priority: 0,
    });
  },
});

const IDLE_DETECTION_SECONDS = 60;

const apis: ActivityApis = {
  async activeTabUrl() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url; // only populated for app.perusall.com (host permission)
  },
  async windowFocused() {
    const win = await chrome.windows.getLastFocused();
    return win.focused === true;
  },
  async perusallTabCount() {
    return (await chrome.tabs.query({ url: PERUSALL_MATCH })).length;
  },
  async idleState() {
    return chrome.idle.queryState(IDLE_DETECTION_SECONDS);
  },
  async hasHostAccess() {
    return chrome.permissions.contains({ origins: [PERUSALL_MATCH] });
  },
};

// The first observation of every browser session must know that the browser was not running
// since the last heartbeat. chrome.storage.session is cleared whenever the browser (or the
// extension) restarts, so a missing marker identifies that first observation reliably, whatever
// order the startup events arrive in. Every handler waits for this before touching the timer.
const SESSION_MARKER = "pbBrowserSessionSeen";
const ready: Promise<void> = (async () => {
  try {
    const seen = (await chrome.storage.session.get(SESSION_MARKER))[SESSION_MARKER] === true;
    if (!seen) {
      await service.startup(true);
      await chrome.storage.session.set({ [SESSION_MARKER]: true });
    }
  } catch {
    // If session storage is unavailable, fall back to normal gap detection (90 s threshold).
  }
})();

// Re-read the activity context after any relevant browser event. Reads are async, so only the
// most recent read is applied (an older, slower read must not overwrite a newer one).
let readSeq = 0;
async function refreshActivity(): Promise<void> {
  await ready;
  const seq = ++readSeq;
  const snapshot = await readActivity(apis);
  if (seq !== readSeq) return;
  await service.updateContext(snapshot.context, snapshot.perusall);
}
const refresh = () => void refreshActivity();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: Response | HistoryResponse | SettingsResponse) => void) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Unsupported sender" });
    return false;
  }
  if (isRequest(message)) {
    void ready.then(() => service.handle(message)).then(sendResponse);
    return true; // async response
  }
  if (isHistoryRequest(message)) {
    void ready.then(() => service.handleHistory(message)).then(sendResponse);
    return true;
  }
  if (isSettingsRequest(message)) {
    void ready.then(() => service.handleSettings(message)).then(sendResponse);
    return true;
  }
  sendResponse({ ok: false, error: "Unsupported message" });
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) refresh(); // observes the timer and re-syncs the context
});

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onRemoved.addListener(refresh);
chrome.tabs.onCreated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url !== undefined || change.status === "complete") refresh();
});
chrome.windows.onFocusChanged.addListener(refresh);
chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
chrome.idle.onStateChanged.addListener(refresh);
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);
// Clicking a reminder simply dismisses it.
chrome.notifications.onClicked.addListener((id) => void chrome.notifications.clear(id));

// onStartup has no work of its own (see `ready`), but registering it guarantees the worker is
// started together with the browser, so a running session is re-evaluated immediately.
chrome.runtime.onStartup.addListener(refresh);
chrome.runtime.onInstalled.addListener(refresh);

// The worker can be started for any event; make sure the context is current.
refresh();
