// Background logic, independent of the global `chrome` object so it can be tested with mocks.
// The service worker (index.ts) wires real chrome.* APIs into this class.
import type { PerusallPresence, PopupView, Request, Response } from "../shared/messages";
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
    const after = await change(before, now, settings);
    try {
      await this.save(after);
    } catch (e) {
      this.storageError = e instanceof StorageError ? e.message : String(e);
      throw e;
    }
    if (before.status !== after.status) await this.syncHeartbeat(after);
    return { state: after, settings };
  }

  /** Hook for finished sessions (persisted to history in a later stage). */
  protected async onSessionFinished(_finished: timer.FinishedSession): Promise<void> {}

  /** Today's personal reading total (running time only). */
  protected async todayMs(state: TimerState, now: number): Promise<number> {
    return overlapMs(timer.segmentsAt(state, now), startOfLocalDay(now), startOfNextLocalDay(now));
  }

  private async view(state: TimerState, settings: Settings, now: number): Promise<PopupView> {
    return {
      now,
      status: state.status,
      startedAt: state.startedAt,
      autoPauseReason: state.autoPauseReason,
      interruptions: state.interruptions,
      note: state.note,
      buckets: timer.bucketsAt(state, now),
      todayMs: await this.todayMs(state, now),
      targetSessionMs: targetSessionMs(settings),
      dailyGoalMs: dailyGoalMs(settings),
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

  /** Browser startup / install: observe, and make sure the heartbeat alarm matches the timer status. */
  startup(): Promise<TimerState> {
    return this.serialize(async () => {
      const { state } = await this.mutate((s, now) => timer.observe(s, now));
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
