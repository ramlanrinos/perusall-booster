// Popup controller. The popup is only a view: every action is a request to the background service
// worker, which owns the timer. Closing the popup therefore never stops or double-counts anything.
import type { PopupView, Request, Response } from "../shared/messages";
import { formatClock, formatShort, percent } from "../shared/time";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const ui = {
  error: $("error"),
  status: $("status"),
  timer: $("timer"),
  sessionProgress: $("session-progress"),
  sessionGoalLabel: $("session-goal-label"),
  start: $<HTMLButtonElement>("btn-start"),
  pause: $<HTMLButtonElement>("btn-pause"),
  resume: $<HTMLButtonElement>("btn-resume"),
  stop: $<HTMLButtonElement>("btn-stop"),
  reset: $<HTMLButtonElement>("btn-reset"),
  note: $<HTMLInputElement>("note"),
  todayTotal: $("today-total"),
  dailyProgress: $("daily-progress"),
  dailyGoalLabel: $("daily-goal-label"),
  perusall: $("perusall-state"),
  indElapsed: $("ind-elapsed"),
  indForeground: $("ind-foreground"),
  indFocused: $("ind-focused"),
  indPaused: $("ind-paused"),
  indUndetermined: $("ind-undetermined"),
  confirmReset: $<HTMLDialogElement>("confirm-reset"),
};

let view: PopupView | null = null;
let receivedAt = 0; // Date.now() when `view` arrived, for smooth local display between refreshes
let busy = false;

async function send(request: Request): Promise<PopupView | null> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as Response | undefined;
    if (!res) throw new Error("No response from the extension background.");
    if (!res.ok) throw new Error(res.error);
    showError(res.view.storageError);
    return res.view;
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return null;
  }
}

function showError(message: string | null): void {
  ui.error.hidden = !message;
  ui.error.textContent = message ?? "";
}

function setProgress(bar: HTMLElement, pct: number): void {
  bar.setAttribute("aria-valuenow", String(pct));
  const fill = bar.firstElementChild as HTMLElement | null;
  if (fill) fill.style.width = `${pct}%`;
}

const STATUS_TEXT = { idle: "Not started", running: "Running", paused: "Paused" } as const;
const AUTO_PAUSE_TEXT = {
  "sleep-or-closed": "Paused automatically (computer asleep or browser closed)",
  locked: "Paused automatically (screen locked)",
} as const;
const PERUSALL_TEXT = {
  foreground: "Perusall: in foreground",
  open: "Perusall: open in background",
  none: "Perusall: not open",
  unknown: "Perusall: not detectable",
} as const;

function render(): void {
  if (!view) return;
  const v = view;
  // Between refreshes, advance only what is certainly still accruing.
  const drift = v.status === "running" ? Math.max(0, Date.now() - receivedAt) : 0;
  const pausedDrift = v.status === "paused" ? Math.max(0, Date.now() - receivedAt) : 0;
  const elapsed = v.buckets.elapsedMs + drift;
  const today = v.todayMs + drift;

  ui.status.dataset.status = v.status;
  ui.status.textContent = v.status === "paused" && v.autoPauseReason ? "Paused (auto)" : STATUS_TEXT[v.status];
  ui.status.title = v.autoPauseReason ? AUTO_PAUSE_TEXT[v.autoPauseReason] : "";
  ui.timer.textContent = formatClock(elapsed);

  setProgress(ui.sessionProgress, percent(elapsed, v.targetSessionMs));
  ui.sessionGoalLabel.textContent = v.targetSessionMs > 0
    ? `Session goal: ${formatShort(elapsed)} of ${formatShort(v.targetSessionMs)}`
    : "Session goal: none set";

  ui.todayTotal.textContent = formatShort(today);
  setProgress(ui.dailyProgress, percent(today, v.dailyGoalMs));
  ui.dailyGoalLabel.textContent = v.dailyGoalMs > 0
    ? `Daily goal: ${formatShort(today)} of ${formatShort(v.dailyGoalMs)} (${percent(today, v.dailyGoalMs)}%)`
    : "Daily goal: none set";

  ui.perusall.dataset.state = v.perusall;
  ui.perusall.textContent = PERUSALL_TEXT[v.perusall];
  ui.indElapsed.textContent = formatShort(elapsed);
  ui.indForeground.textContent = formatShort(v.buckets.foregroundMs);
  ui.indFocused.textContent = formatShort(v.buckets.focusedMs);
  ui.indPaused.textContent = formatShort(v.buckets.pausedMs + pausedDrift);
  ui.indUndetermined.textContent = formatShort(v.buckets.undeterminedMs);

  const idle = v.status === "idle";
  ui.start.hidden = !idle;
  ui.pause.hidden = v.status !== "running";
  ui.resume.hidden = v.status !== "paused";
  for (const b of [ui.start, ui.pause, ui.resume]) b.disabled = busy;
  ui.stop.disabled = busy || idle;
  ui.reset.disabled = busy || idle;
  ui.note.disabled = idle;
  if (document.activeElement !== ui.note) ui.note.value = v.note;
}

async function act(request: Request): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  const next = await send(request);
  busy = false;
  if (next) {
    view = next;
    receivedAt = Date.now();
  }
  render();
}

async function refresh(): Promise<void> {
  if (busy) return;
  const next = await send({ type: "getState" });
  if (next) {
    view = next;
    receivedAt = Date.now();
    render();
  }
}

ui.start.addEventListener("click", () => void act({ type: "start" }));
ui.pause.addEventListener("click", () => void act({ type: "pause" }));
ui.resume.addEventListener("click", () => void act({ type: "resume" }));
ui.stop.addEventListener("click", () => void act({ type: "stop", note: ui.note.value }));
ui.reset.addEventListener("click", () => {
  ui.confirmReset.returnValue = "";
  ui.confirmReset.showModal();
});
ui.confirmReset.addEventListener("close", () => {
  if (ui.confirmReset.returnValue === "confirm") void act({ type: "reset" });
});

let noteTimer: ReturnType<typeof setTimeout> | undefined;
ui.note.addEventListener("input", () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => void send({ type: "setNote", note: ui.note.value }), 400);
});

for (const id of ["open-options", "open-options-2"]) {
  document.getElementById(id)?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
}
document.getElementById("open-history")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("pages/history.html") });
});

void refresh();
setInterval(render, 1000);
setInterval(() => void refresh(), 5000);
