import { MINUTE_MS } from "./time";

export interface Settings {
  /** Personal target length of one session (0 = no target). */
  targetSessionMinutes: number;
  /** Personal daily reading goal (0 = no goal). */
  dailyGoalMinutes: number;
  /** Remind to take a break after this many minutes of running time (0 = off). */
  breakReminderMinutes: number;
  notifyBreaks: boolean;
  notifySessionGoal: boolean;
  notifyDailyGoal: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  targetSessionMinutes: 30,
  dailyGoalMinutes: 60,
  breakReminderMinutes: 25,
  notifyBreaks: true,
  notifySessionGoal: true,
  notifyDailyGoal: true,
});

export const LIMITS = {
  targetSessionMinutes: { min: 0, max: 600 },
  dailyGoalMinutes: { min: 0, max: 1440 },
  breakReminderMinutes: { min: 0, max: 240 },
} as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Returns valid settings from untrusted input, falling back to defaults per field. */
export function sanitizeSettings(input: unknown): Settings {
  const v = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const bool = (key: keyof Settings) =>
    typeof v[key] === "boolean" ? (v[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean);
  return {
    targetSessionMinutes: clampInt(v.targetSessionMinutes, LIMITS.targetSessionMinutes.min, LIMITS.targetSessionMinutes.max, DEFAULT_SETTINGS.targetSessionMinutes),
    dailyGoalMinutes: clampInt(v.dailyGoalMinutes, LIMITS.dailyGoalMinutes.min, LIMITS.dailyGoalMinutes.max, DEFAULT_SETTINGS.dailyGoalMinutes),
    breakReminderMinutes: clampInt(v.breakReminderMinutes, LIMITS.breakReminderMinutes.min, LIMITS.breakReminderMinutes.max, DEFAULT_SETTINGS.breakReminderMinutes),
    notifyBreaks: bool("notifyBreaks"),
    notifySessionGoal: bool("notifySessionGoal"),
    notifyDailyGoal: bool("notifyDailyGoal"),
  };
}

export const targetSessionMs = (s: Settings) => s.targetSessionMinutes * MINUTE_MS;
export const dailyGoalMs = (s: Settings) => s.dailyGoalMinutes * MINUTE_MS;
