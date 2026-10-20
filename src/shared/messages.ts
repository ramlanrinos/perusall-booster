// Contract between the popup / extension pages and the background service worker.
import type { AutoPauseReason, Buckets, TimerStatus } from "./timer";

export type Request =
  | { type: "getState" }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop"; note?: string }
  | { type: "reset" }
  | { type: "setNote"; note: string };

export type PerusallPresence = "foreground" | "open" | "none" | "unknown";

export interface PopupView {
  now: number;
  status: TimerStatus;
  startedAt: number | null;
  autoPauseReason: AutoPauseReason | null;
  interruptions: number;
  note: string;
  buckets: Buckets;
  todayMs: number;
  targetSessionMs: number;
  dailyGoalMs: number;
  perusall: PerusallPresence;
  /** Last storage failure, if any (shown as a banner). */
  storageError: string | null;
}

export type Response = { ok: true; view: PopupView } | { ok: false; error: string };

const REQUEST_TYPES = new Set(["getState", "start", "pause", "resume", "stop", "reset", "setNote"]);

/** Validates an incoming message; anything else is rejected. */
export function isRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string" || !REQUEST_TYPES.has(v.type)) return false;
  if (v.type === "setNote" && typeof v.note !== "string") return false;
  if (v.type === "stop" && v.note !== undefined && typeof v.note !== "string") return false;
  return true;
}
