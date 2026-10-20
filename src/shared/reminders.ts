// Decides which personal reminders are due. Pure: the background service persists the result and
// shows the notifications. Reminders are about the extension's own timer only.
import type { Settings } from "./settings";
import { MINUTE_MS, formatShort } from "./time";
import type { TimerState } from "./timer";

export type ReminderKind = "break" | "session-goal" | "daily-goal";

export interface Reminder {
  kind: ReminderKind;
  title: string;
  message: string;
}

export interface ReminderInput {
  state: TimerState;
  settings: Settings;
  /** Elapsed timer time of the current session at `now`. */
  elapsedMs: number;
  /** Today's personal total at `now`. */
  todayMs: number;
  /** Local date key (YYYY-MM-DD) for `now`. */
  today: string;
  /** Local date key on which the daily-goal reminder was last shown. */
  dailyGoalNotifiedOn: string | null;
}

export interface ReminderResult {
  state: TimerState;
  dailyGoalNotifiedOn: string | null;
  due: Reminder[];
}

export function localDateKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function evaluateReminders(input: ReminderInput): ReminderResult {
  const { settings, elapsedMs, todayMs, today } = input;
  let state = input.state;
  let dailyGoalNotifiedOn = input.dailyGoalNotifiedOn;
  const due: Reminder[] = [];
  if (state.status !== "running") return { state, dailyGoalNotifiedOn, due };

  const breakMs = settings.breakReminderMinutes * MINUTE_MS;
  if (breakMs > 0 && elapsedMs - state.reminders.lastBreakAtElapsedMs >= breakMs) {
    state = { ...state, reminders: { ...state.reminders, lastBreakAtElapsedMs: elapsedMs } };
    if (settings.notifyBreaks) {
      due.push({
        kind: "break",
        title: "Time for a short break",
        message: `You've had your personal timer running for ${formatShort(breakMs)} since your last break. Pause it while you rest.`,
      });
    }
  }

  const targetMs = settings.targetSessionMinutes * MINUTE_MS;
  if (targetMs > 0 && elapsedMs >= targetMs && !state.reminders.sessionGoalNotified) {
    state = { ...state, reminders: { ...state.reminders, sessionGoalNotified: true } };
    if (settings.notifySessionGoal) {
      due.push({ kind: "session-goal", title: "Session goal reached", message: `${formatShort(targetMs)} on your personal timer this session.` });
    }
  }

  const dailyMs = settings.dailyGoalMinutes * MINUTE_MS;
  if (dailyMs > 0 && todayMs >= dailyMs && dailyGoalNotifiedOn !== today) {
    dailyGoalNotifiedOn = today;
    if (settings.notifyDailyGoal) {
      due.push({ kind: "daily-goal", title: "Daily goal reached", message: `${formatShort(dailyMs)} of personal reading time today.` });
    }
  }
  return { state, dailyGoalNotifiedOn, due };
}

/** Milliseconds of running time until the next break reminder, or null when off. */
export function nextBreakInMs(state: TimerState, settings: Settings, elapsedMs: number): number | null {
  const breakMs = settings.breakReminderMinutes * MINUTE_MS;
  if (breakMs <= 0 || state.status === "idle") return null;
  return Math.max(0, breakMs - (elapsedMs - state.reminders.lastBreakAtElapsedMs));
}
