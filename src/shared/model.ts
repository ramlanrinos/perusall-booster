// Runtime validation for everything read back from storage. Stored data can be corrupted,
// written by an older version, or edited by hand, so it is never trusted blindly.
import { MAX_NOTE_LENGTH, initialTimerState } from "./timer";
import type { ActivityContext, Buckets, Segment, TimerState } from "./timer";

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonNeg = (v: unknown): v is number => isNum(v) && v >= 0;
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const MAX_SEGMENTS = 5000;

function validBuckets(v: unknown): Buckets | null {
  if (!isObj(v)) return null;
  const keys = ["elapsedMs", "pausedMs", "undeterminedMs", "focusedMs", "foregroundMs"] as const;
  if (!keys.every((k) => isNonNeg(v[k]))) return null;
  const b = Object.fromEntries(keys.map((k) => [k, v[k]])) as unknown as Buckets;
  // Subset buckets can never exceed elapsed time.
  if (b.focusedMs > b.elapsedMs || b.foregroundMs > b.focusedMs) return null;
  return b;
}

function validSegments(v: unknown): Segment[] | null {
  if (!Array.isArray(v) || v.length > MAX_SEGMENTS) return null;
  const out: Segment[] = [];
  for (const s of v) {
    if (!isObj(s) || !isNonNeg(s.start) || !isNonNeg(s.end) || s.end < s.start) return null;
    out.push({ start: s.start, end: s.end });
  }
  return out;
}

function validContext(v: unknown): ActivityContext | null {
  if (!isObj(v)) return null;
  if (typeof v.perusallForeground !== "boolean" || typeof v.windowFocused !== "boolean" || typeof v.locked !== "boolean") return null;
  return { perusallForeground: v.perusallForeground, windowFocused: v.windowFocused, locked: v.locked };
}

/** Returns a valid TimerState, or null if the stored value is unusable. */
export function parseTimerState(v: unknown): TimerState | null {
  if (v === undefined) return initialTimerState();
  if (!isObj(v)) return null;
  const status = v.status;
  if (status !== "idle" && status !== "running" && status !== "paused") return null;
  const buckets = validBuckets(v.buckets);
  const segments = validSegments(v.segments);
  const context = validContext(v.context);
  if (!buckets || !segments || !context) return null;
  if (!numOrNull(v.startedAt) || !numOrNull(v.runningSince) || !numOrNull(v.lastObservedAt) || !numOrNull(v.lastHeartbeatAt)) return null;
  if (v.sessionId !== null && typeof v.sessionId !== "string") return null;
  if (v.autoPauseReason !== null && v.autoPauseReason !== "sleep-or-closed" && v.autoPauseReason !== "locked") return null;
  if (!isNonNeg(v.interruptions) || typeof v.note !== "string") return null;
  const rem = isObj(v.reminders) ? v.reminders : null;
  if (!rem || !isNonNeg(rem.lastBreakAtElapsedMs) || typeof rem.sessionGoalNotified !== "boolean") return null;

  // Cross-field consistency.
  if (status === "idle") return { ...initialTimerState(), context };
  if (v.sessionId === null || v.startedAt === null || v.lastObservedAt === null) return null;
  if (status === "running" && v.runningSince === null) return null;

  return {
    status,
    sessionId: v.sessionId as string,
    startedAt: v.startedAt as number,
    runningSince: status === "running" ? (v.runningSince as number) : null,
    lastObservedAt: v.lastObservedAt as number,
    lastHeartbeatAt: (v.lastHeartbeatAt as number | null) ?? (v.lastObservedAt as number),
    autoPauseReason: v.autoPauseReason as TimerState["autoPauseReason"],
    interruptions: v.interruptions,
    context,
    buckets,
    segments,
    note: v.note.slice(0, MAX_NOTE_LENGTH),
    reminders: { lastBreakAtElapsedMs: rem.lastBreakAtElapsedMs, sessionGoalNotified: rem.sessionGoalNotified },
  };
}
