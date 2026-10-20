// Perusall Booster service worker: owns the personal timer and answers popup requests.
// It never contacts Perusall or any other server, and injects nothing into web pages.
import { isHistoryRequest, isRequest, type HistoryResponse, type Response } from "../shared/messages";
import { PERUSALL_MATCH } from "../shared/perusall";
import { readActivity, type ActivityApis } from "./activity";
import { BackgroundService, HEARTBEAT_ALARM } from "./service";
import { Store } from "./storage";

const service = new BackgroundService({
  store: new Store(chrome.storage.local),
  alarms: chrome.alarms,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
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

// Re-read the activity context after any relevant browser event. Reads are async, so only the
// most recent read is applied (an older, slower read must not overwrite a newer one).
let readSeq = 0;
async function refreshActivity(): Promise<void> {
  const seq = ++readSeq;
  const snapshot = await readActivity(apis);
  if (seq !== readSeq) return;
  await service.updateContext(snapshot.context, snapshot.perusall);
}
const refresh = () => void refreshActivity();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: Response | HistoryResponse) => void) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Unsupported sender" });
    return false;
  }
  if (isRequest(message)) {
    void service.handle(message).then(sendResponse);
    return true; // async response
  }
  if (isHistoryRequest(message)) {
    void service.handleHistory(message).then(sendResponse);
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

// After a browser restart, observe immediately so the closed period is classified as "not determined".
chrome.runtime.onStartup.addListener(() => void service.startup().then(refreshActivity));
chrome.runtime.onInstalled.addListener(() => void service.startup().then(refreshActivity));

// The worker can be started for any event; make sure the context is current.
refresh();
