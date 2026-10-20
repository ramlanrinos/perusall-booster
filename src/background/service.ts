// Background logic, independent of the global `chrome` object so it can be tested with mocks.
// The service worker (index.ts) wires real chrome.* APIs into this class.
import type {
  HistoryRequest, HistoryResponse, PerusallPresence, PopupView, Request, Response, SettingsRequest, SettingsResponse,
} from "../shared/messages";
import { evaluateReminders, localDateKey, nextBreakInMs, type Reminder } from "../shared/reminders";
import { recordFromFinished } from "../shared/model";
import { MINUTE_MS } from "../shared/time";
import { dailyGoalMs, targetSessionMs, type Settings } from "../shared/settings";
import { overlapMs, startOfLocalDay, startOfNextLocalDay } from "../shared/time";
import * as timer from "../shared/timer";
import type { ActivityContext, TimerState } from "../shared/timer";
import { StorageError, type Store } from "./storage";

export const HEARTBEAT_ALARM = "pb-heartbeat";

export interface AlarmsLike {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): unknown;
  clear(name: string): Promise<boolean>;
}

export interface ServiceDeps {
  store: Store;
  alarms: AlarmsLike;
  now: () => number;
  newId: () => string;
  /** Shows a personal reminder (chrome.notifications in the extension). */
  notify: (reminder: Reminder) => Promise<void> | void;
}

export class BackgroundService {
  private queue: Promise<unknown> = Promise.resolve();
  private storageError: string | null = null;
  private perusall: PerusallPresence = "unknown";

  constructor(private readonly deps: ServiceDeps) {}

  /** Runs state changes one at a time so concurrent events can't interleave read-modify-write. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<TimerState> {
    const { state, recovered } = await this.deps.store.loadTimer();
    if (recovered) this.storageError = "Saved timer data was unreadable and has been reset (a backup was kept).";
    return state;
  }

  private async save(state: TimerState): Promise<void> {
    await this.deps.store.saveTimer(state);
    if (this.storageError?.startsWith("Could not save")) this.storageError = null;
  }

  private async syncHeartbeat(state: TimerState): Promise<void> {
    if (state.status === "idle") {
      await this.deps.alarms.clear(HEARTBEAT_ALARM);
    } else {
      // Re-creating an alarm with the same name replaces it; period is 30 s (Chrome's minimum).
      this.deps.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: timer.HEARTBEAT_PERIOD_MS / 60_000 });
    }
  }

  /** Observes, applies `change`, persists. Returns the new state. */
  private async mutate(change: (s: TimerState, now: number, settings: Settings) => TimerState | Promise<TimerState>): Promise<{ state: TimerState; settings: Settings }> {
    const now = this.deps.now();
    const settings = await this.deps.store.loadSettings();
    const before = await this.load();
    const changed = await change(before, now, settings);

    // Personal reminders are evaluated on every observation (heartbeat granularity: 30 s).
    const notifiedOn = await this.deps.store.loadDailyGoalNotifiedOn();
    const reminders = evaluateReminders({
      state: changed,
      settings,
      elapsedMs: timer.bucketsAt(changed, now).elapsedMs,
      todayMs: await this.todayMs(changed, now),
      today: localDateKey(now),
      dailyGoalNotifiedOn: notifiedOn,
    });
    const after = reminders.state;
    try {
      await this.save(after);
      if (reminders.dailyGoalNotifiedOn !== notifiedOn) await this.deps.store.saveDailyGoalNotifiedOn(reminders.dailyGoalNotifiedOn);
    } catch (e) {
      this.storageError = e instanceof StorageError ? e.message : String(e);
      throw e;
    }
    if (before.status !== after.status) await this.syncHeartbeat(after);
    for (const r of reminders.due) {
      try {
        await this.deps.notify(r);
      } catch {
        // Notifications are optional (they may be blocked by the OS); the timer is unaffected.
      }
    }
    return { state: after, settings };
  }

  /**
   * Saves a finished session to history. Called *before* the idle timer is persisted: if saving
   * fails, the whole stop fails and the session stays active, so nothing is lost.
   */
  private async onSessionFinished(finished: timer.FinishedSession): Promise<void> {
    await this.deps.store.addSession(recordFromFinished(finished));
  }

  /** Today's personal reading total: running time of saved sessions plus the current one. */
  private async todayMs(state: TimerState, now: number): Promise<number> {
    const from = startOfLocalDay(now);
    const to = startOfNextLocalDay(now);
    let total = overlapMs(timer.segmentsAt(state, now), from, to);
    try {
      const { sessions } = await this.deps.store.loadSessions();
      for (const s of sessions) if (s.endedAt >= from && s.startedAt < to) total += overlapMs(s.segments, from, to);
    } catch (e) {
      this.storageError = e instanceof Error ? e.message : String(e);
    }
    return total;
  }

  private async view(state: TimerState, settings: Settings, now: number): Promise<PopupView> {
    const buckets = timer.bucketsAt(state, now);
    return {
      now,
      status: state.status,
      startedAt: state.startedAt,
      autoPauseReason: state.autoPauseReason,
      interruptions: state.interruptions,
      note: state.note,
      buckets,
      todayMs: await this.todayMs(state, now),
      targetSessionMs: targetSessionMs(settings),
      dailyGoalMs: dailyGoalMs(settings),
      breakReminderMs: settings.breakReminderMinutes * MINUTE_MS,
      nextBreakMs: nextBreakInMs(state, settings, buckets.elapsedMs),
      perusall: this.perusall,
      storageError: this.storageError,
    };
  }

  handle(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        const { state, settings } = await this.mutate(async (s, now, settings) => {
          switch (request.type) {
            case "getState":
              return timer.observe(s, now);
            case "start":
              return timer.start(s, now, this.deps.newId());
            case "pause":
              return timer.pause(s, now);
            case "resume":
              return timer.resume(s, now);
            case "setNote":
              return timer.setNote(timer.observe(s, now), request.note);
            case "reset":
              return timer.reset(timer.observe(s, now));
            case "stop": {
              const withNote = request.note !== undefined ? timer.setNote(s, request.note) : s;
              const { state: idle, finished } = timer.stop(withNote, now, targetSessionMs(settings));
              if (finished) await this.onSessionFinished(finished);
              return idle;
            }
          }
        });
        return { ok: true, view: await this.view(state, settings, this.deps.now()) };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (e instanceof StorageError) this.storageError = error;
        return { ok: false, error };
      }
    });
  }

  handleHistory(request: HistoryRequest): Promise<HistoryResponse> {
    return this.serialize(async () => {
      try {
        const store = this.deps.store;
        if (request.type === "deleteSession") await store.deleteSession(request.id);
        if (request.type === "clearSessions") await store.clearSessions();
        return { ok: true, history: await store.loadSessions() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  handleSettings(request: SettingsRequest): Promise<SettingsResponse> {
    return this.serialize(async () => {
      try {
        const store = this.deps.store;
        if (request.type === "saveSettings") return { ok: true, settings: await store.saveSettings(request.settings) };
        const settings = await store.loadSettings();
        if (request.type === "testNotification") {
          await this.deps.notify({ kind: "break", title: "Perusall Booster test", message: "Reminders are working. This is a test notification." });
        }
        return { ok: true, settings };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /**
   * Browser startup (`browserRestarted`) or extension install/update: observe, and make sure the
   * heartbeat alarm matches the timer status. After a browser restart the time since the last
   * heartbeat is never counted as reading time, however short it was.
   */
  startup(browserRestarted = false): Promise<TimerState> {
    return this.serialize(async () => {
      const { state } = await this.mutate((s, now) => timer.observe(s, now, { knownGap: browserRestarted }));
      await this.syncHeartbeat(state);
      return state;
    });
  }

  /** Heartbeat alarm and worker wake-ups: observe so gaps are detected promptly. */
  tick(): Promise<TimerState> {
    return this.serialize(async () => (await this.mutate((s, now) => timer.observe(s, now))).state);
  }

  /** Applies a new activity context (tab/window/lock changes). */
  updateContext(ctx: ActivityContext, perusall: PerusallPresence): Promise<TimerState> {
    this.perusall = perusall;
    return this.serialize(async () => (await this.mutate((s, now) => timer.setContext(s, now, ctx))).state);
  }
}
