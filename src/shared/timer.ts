// Pure timer engine. No chrome.* APIs: every function takes the current time explicitly so the
// logic is deterministic and unit-testable. The background service worker is the only caller that
// persists the returned state.
//
// Time model
// ----------
// The wall-clock time of a session is partitioned into three buckets that never overlap:
//   elapsedMs       the timer was running
//   pausedMs        the timer was paused (by the user, or after an automatic pause)
//   undeterminedMs  the extension could not observe anything: computer asleep, browser closed,
//                   or screen locked
// Two further buckets are *subsets* of elapsedMs:
//   focusedMs       some browser window had focus
//   foregroundMs    the active tab of the focused window was a Perusall page
//
// Durations are accrued from timestamps (never from a ticking counter), and only for the interval
// (lastObservedAt, now]. Observing the same instant twice adds nothing, so no time can be counted
// twice. A clock that moves backwards adds nothing either.

export type TimerStatus = "idle" | "running" | "paused";
export type AutoPauseReason = "sleep-or-closed" | "locked";

export interface ActivityContext {
  /** The active tab of the focused browser window is a Perusall page. */
  perusallForeground: boolean;
  /** Some browser window has focus. */
  windowFocused: boolean;
  /** The operating system reports the screen as locked. */
  locked: boolean;
}

export interface Buckets {
  elapsedMs: number;
  pausedMs: number;
  undeterminedMs: number;
  focusedMs: number;
  foregroundMs: number;
}

export interface Segment {
  start: number;
  end: number;
}

export interface TimerState {
  status: TimerStatus;
  sessionId: string | null;
  startedAt: number | null;
  /** Start of the current running segment (status === "running"). */
  runningSince: number | null;
  /** Everything up to this instant has been accrued into the buckets. */
  lastObservedAt: number | null;
  /** Last instant the extension is known to have been alive (any observation). */
  lastHeartbeatAt: number | null;
  autoPauseReason: AutoPauseReason | null;
  /** Number of automatic pauses in this session (sleep, browser closed, screen locked). */
  interruptions: number;
  context: ActivityContext;
  buckets: Buckets;
  /** Closed running segments; used to split time across days. */
  segments: Segment[];
  note: string;
  reminders: {
    /** elapsedMs value at which the last break reminder fired (or session start). */
    lastBreakAtElapsedMs: number;
    sessionGoalNotified: boolean;
  };
}

/** No observation for longer than this means the browser could not run (asleep, closed). */
export const SUSPEND_GAP_MS = 90_000;
/** Heartbeat alarm period. Chrome's minimum alarm period is 30 s. */
export const HEARTBEAT_PERIOD_MS = 30_000;
export const MAX_NOTE_LENGTH = 500;

export const emptyBuckets = (): Buckets => ({
  elapsedMs: 0,
  pausedMs: 0,
  undeterminedMs: 0,
  focusedMs: 0,
  foregroundMs: 0,
});

export const defaultContext = (): ActivityContext => ({
  perusallForeground: false,
  windowFocused: false,
  locked: false,
});

export function initialTimerState(): TimerState {
  return {
    status: "idle",
    sessionId: null,
    startedAt: null,
    runningSince: null,
    lastObservedAt: null,
    lastHeartbeatAt: null,
    autoPauseReason: null,
    interruptions: 0,
    context: defaultContext(),
    buckets: emptyBuckets(),
    segments: [],
    note: "",
    reminders: { lastBreakAtElapsedMs: 0, sessionGoalNotified: false },
  };
}

function clone(state: TimerState): TimerState {
  return {
    ...state,
    context: { ...state.context },
    buckets: { ...state.buckets },
    segments: state.segments.map((s) => ({ ...s })),
    reminders: { ...state.reminders },
  };
}

/** Adds a running interval of length d to the buckets that applied during it. */
function accrueRunning(b: Buckets, ctx: ActivityContext, d: number): void {
  b.elapsedMs += d;
  if (ctx.windowFocused) b.focusedMs += d;
  if (ctx.windowFocused && ctx.perusallForeground) b.foregroundMs += d;
}

function closeSegment(s: TimerState, at: number): void {
  if (s.runningSince !== null) {
    const start = Math.min(s.runningSince, at);
    if (at > start) s.segments.push({ start, end: at });
    s.runningSince = null;
  }
}

/** Pauses a running timer on the user's behalf. A timer the user already paused stays as it is. */
function autoPause(s: TimerState, at: number, reason: AutoPauseReason): void {
  if (s.status !== "running") return;
  closeSegment(s, at);
  s.status = "paused";
  s.autoPauseReason = reason;
  s.interruptions += 1;
}

/**
 * Brings the buckets up to `now` using the context that applied since the last observation.
 * Detects gaps longer than SUSPEND_GAP_MS (sleep / browser closed): the gap is recorded as
 * undetermined and a running timer is paused at the last known-alive instant.
 */
export function observe(state: TimerState, now: number): TimerState {
  const s = clone(state);
  if (s.status === "idle" || s.lastObservedAt === null) {
    s.lastHeartbeatAt = now;
    return s;
  }

  // Clock moved backwards: never subtract time; restart accounting from `now`.
  if (now < s.lastObservedAt) {
    s.lastObservedAt = now;
    s.lastHeartbeatAt = now;
    if (s.runningSince !== null && s.runningSince > now) s.runningSince = now;
    return s;
  }

  const lastAlive = Math.max(s.lastHeartbeatAt ?? s.lastObservedAt, s.lastObservedAt);
  if (now - lastAlive > SUSPEND_GAP_MS) {
    // Accrue normally up to the last instant we know the browser was alive, then pause there.
    advance(s, lastAlive);
    autoPause(s, lastAlive, "sleep-or-closed");
    s.buckets.undeterminedMs += now - lastAlive;
    s.lastObservedAt = now;
    s.lastHeartbeatAt = now;
    return s;
  }

  advance(s, now);
  s.lastHeartbeatAt = now;
  return s;
}

/** Accrues (lastObservedAt, to] with the current context; no gap detection. */
function advance(s: TimerState, to: number): void {
  const from = s.lastObservedAt ?? to;
  const d = to - from;
  if (d <= 0) return;
  if (s.status === "running") {
    if (s.context.locked) {
      // Defensive: a locked screen normally auto-pauses (see setContext).
      s.buckets.undeterminedMs += d;
    } else {
      accrueRunning(s.buckets, s.context, d);
    }
  } else if (s.status === "paused") {
    if (s.context.locked) s.buckets.undeterminedMs += d;
    else s.buckets.pausedMs += d;
  }
  s.lastObservedAt = to;
}

// ---------------------------------------------------------------------------------------------
// Commands. Each one first observes up to `now`. Commands that do not apply to the current
// status return the observed state unchanged (idempotent: a double-clicked Start is harmless).

export function start(state: TimerState, now: number, sessionId: string): TimerState {
  if (state.status !== "idle") return observe(state, now);
  return {
    ...initialTimerState(),
    status: "running",
    sessionId,
    startedAt: now,
    runningSince: now,
    lastObservedAt: now,
    lastHeartbeatAt: now,
    context: { ...state.context },
  };
}

export function pause(state: TimerState, now: number): TimerState {
  const s = observe(state, now);
  if (s.status !== "running") return s;
  closeSegment(s, now);
  s.status = "paused";
  s.autoPauseReason = null;
  // A pause is a break: the break-reminder interval restarts from here.
  s.reminders.lastBreakAtElapsedMs = s.buckets.elapsedMs;
  return s;
}

export function resume(state: TimerState, now: number): TimerState {
  const s = observe(state, now);
  if (s.status !== "paused") return s;
  s.status = "running";
  s.runningSince = now;
  s.autoPauseReason = null;
  return s;
}

export function setNote(state: TimerState, note: string): TimerState {
  if (state.status === "idle") return state;
  return { ...clone(state), note: note.slice(0, MAX_NOTE_LENGTH) };
}

/** Discards the current session. */
export function reset(state: TimerState): TimerState {
  return { ...initialTimerState(), context: { ...state.context } };
}

/**
 * Applies a new activity context. The interval before `now` is accrued with the *previous* context.
 * Locking the screen pauses a running timer; unlocking leaves it paused (the user decides).
 */
export function setContext(state: TimerState, now: number, ctx: ActivityContext): TimerState {
  const s = observe(state, now);
  const wasLocked = s.context.locked;
  s.context = { ...ctx };
  if (!wasLocked && ctx.locked && s.status === "running") autoPause(s, now, "locked");
  return s;
}

export type CompletionStatus = "completed" | "ended-early";

export interface FinishedSession {
  id: string;
  startedAt: number;
  endedAt: number;
  buckets: Buckets;
  segments: Segment[];
  interruptions: number;
  note: string;
  status: CompletionStatus;
}

/** Stops the session. Returns the idle state and the finished session (null if none was active). */
export function stop(
  state: TimerState,
  now: number,
  targetSessionMs: number,
): { state: TimerState; finished: FinishedSession | null } {
  const s = observe(state, now);
  if (s.status === "idle" || s.sessionId === null || s.startedAt === null) {
    return { state: s, finished: null };
  }
  if (s.status === "running") closeSegment(s, s.lastObservedAt ?? now);
  const endedAt = Math.max(s.lastObservedAt ?? now, s.startedAt);
  const finished: FinishedSession = {
    id: s.sessionId,
    startedAt: s.startedAt,
    endedAt,
    buckets: { ...s.buckets },
    segments: s.segments.map((x) => ({ ...x })),
    interruptions: s.interruptions,
    note: s.note.trim(),
    status: targetSessionMs > 0 && s.buckets.elapsedMs < targetSessionMs ? "ended-early" : "completed",
  };
  return { state: { ...initialTimerState(), context: { ...s.context } }, finished };
}

/**
 * Read-only projection for display: the buckets as they would be at `now`, without gap handling
 * (the background applies gaps when it observes). Never persisted.
 */
export function bucketsAt(state: TimerState, now: number): Buckets {
  const s = clone(state);
  if (s.status !== "idle" && s.lastObservedAt !== null && now > s.lastObservedAt) advance(s, now);
  return s.buckets;
}

/** Running segments including the open one, for daily totals. */
export function segmentsAt(state: TimerState, now: number): Segment[] {
  const segs = state.segments.map((x) => ({ ...x }));
  if (state.status === "running" && state.runningSince !== null && now > state.runningSince) {
    segs.push({ start: state.runningSince, end: now });
  }
  return segs;
}
