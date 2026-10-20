// Perusall Booster service worker: owns the personal timer and answers popup requests.
// It never contacts Perusall or any other server.
import { isRequest, type Response } from "../shared/messages";
import { BackgroundService, HEARTBEAT_ALARM } from "./service";
import { Store } from "./storage";

const service = new BackgroundService({
  store: new Store(chrome.storage.local),
  alarms: chrome.alarms,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: Response) => void) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id || !isRequest(message)) {
    sendResponse({ ok: false, error: "Unsupported message" });
    return false;
  }
  void service.handle(message).then(sendResponse);
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) void service.tick();
});

// After a browser restart, observe immediately so the closed period is classified as "not determined".
chrome.runtime.onStartup.addListener(() => void service.startup());
chrome.runtime.onInstalled.addListener(() => void service.startup());
