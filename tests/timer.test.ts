import { describe, expect, it } from "vitest";
import * as t from "../src/shared/timer";
import type { ActivityContext, TimerState } from "../src/shared/timer";
import { MIN, SEC } from "./helpers";

const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const ctx = (over: Partial<ActivityContext> = {}): ActivityContext => ({
  perusallForeground: false, windowFocused: true, locked: false, ...over,
});

/** elapsed + paused + undetermined always equals the observed session wall-clock time. */
function expectPartition(s: TimerState) {
  const b = s.buckets;
  expect(b.elapsedMs + b.pausedMs + b.undeterminedMs).toBe((s.lastObservedAt ?? 0) - (s.startedAt ?? 0));
  expect(b.focusedMs).toBeLessThanOrEqual(b.elapsedMs);
  expect(b.foregroundMs).toBeLessThanOrEqual(b.focusedMs);
}

describe("timer state machine", () => {
  it("starts, pauses, resumes and stops with exact durations", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    expect(s.status).toBe("running");
    s = t.observe(s, T0 + 20 * SEC); // heartbeat
    s = t.pause(s, T0 + 50 * SEC);
    expect(s.status).toBe("paused");
    s = t.resume(s, T0 + 80 * SEC);
    const { state, finished } = t.stop(s, T0 + 100 * SEC, 0);
    expect(state.status).toBe("idle");
    expect(finished?.buckets.elapsedMs).toBe(70 * SEC);
    expect(finished?.buckets.pausedMs).toBe(30 * SEC);
    expect(finished?.segments).toEqual([
      { start: T0, end: T0 + 50 * SEC },
      { start: T0 + 80 * SEC, end: T0 + 100 * SEC },
    ]);
    expect(finished?.startedAt).toBe(T0);
    expect(finished?.endedAt).toBe(T0 + 100 * SEC);
  });

  it("ignores commands that do not apply (double clicks are harmless)", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    const again = t.start(s, T0 + 10 * SEC, "s2");
    expect(again.sessionId).toBe("s1");
    expect(again.startedAt).toBe(T0);
    s = t.pause(again, T0 + 20 * SEC);
    const pausedTwice = t.pause(s, T0 + 25 * SEC);
    expect(pausedTwice.status).toBe("paused");
    expect(pausedTwice.segments).toHaveLength(1);
    expect(t.resume(t.initialTimerState(), T0).status).toBe("idle");
    expect(t.pause(t.initialTimerState(), T0).status).toBe("idle");
  });

  it("never counts the same interval twice", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    for (let i = 0; i < 5; i++) s = t.observe(s, T0 + 10 * SEC); // popup reopened 5 times at the same instant
    s = t.observe(s, T0 + 10 * SEC);
    expect(s.buckets.elapsedMs).toBe(10 * SEC);
    s = t.observe(s, T0 + 15 * SEC);
    expect(s.buckets.elapsedMs).toBe(15 * SEC);
  });

  it("does not subtract or add time when the clock moves backwards", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    s = t.observe(s, T0 + 30 * SEC);
    s = t.observe(s, T0 + 10 * SEC); // clock set back 20 s
    expect(s.buckets.elapsedMs).toBe(30 * SEC);
    s = t.observe(s, T0 + 20 * SEC);
    expect(s.buckets.elapsedMs).toBe(40 * SEC);
  });

  it("treats a gap without heartbeats as sleep: undetermined, and pauses at the last alive instant", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    s = t.observe(s, T0 + 30 * SEC);
    s = t.observe(s, T0 + 60 * SEC); // last heartbeat before sleep
    s = t.observe(s, T0 + 60 * SEC + 10 * MIN); // wake up 10 min later
    expect(s.status).toBe("paused");
    expect(s.autoPauseReason).toBe("sleep-or-closed");
    expect(s.interruptions).toBe(1);
    expect(s.buckets.elapsedMs).toBe(60 * SEC);
    expect(s.buckets.undeterminedMs).toBe(10 * MIN);
    expect(s.segments).toEqual([{ start: T0, end: T0 + 60 * SEC }]);
    expectPartition(s);
  });

  it("allows normal heartbeat jitter below the suspend threshold", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    s = t.observe(s, T0 + t.SUSPEND_GAP_MS); // exactly at the threshold is still alive
    expect(s.status).toBe("running");
    expect(s.buckets.elapsedMs).toBe(t.SUSPEND_GAP_MS);
  });

  it("keeps a user-paused session paused through sleep without counting an interruption", () => {
    let s = t.pause(t.start(t.initialTimerState(), T0, "s1"), T0 + 10 * SEC);
    s = t.observe(s, T0 + 10 * SEC + 30 * MIN);
    expect(s.status).toBe("paused");
    expect(s.autoPauseReason).toBeNull();
    expect(s.interruptions).toBe(0);
    expect(s.buckets.undeterminedMs).toBe(30 * MIN);
    expect(s.buckets.pausedMs).toBe(0);
  });

  it("auto-pauses when the screen locks and stays paused after unlock", () => {
    let s = t.setContext(t.start(t.initialTimerState(), T0, "s1"), T0, ctx());
    s = t.setContext(s, T0 + 40 * SEC, ctx({ locked: true }));
    expect(s.status).toBe("paused");
    expect(s.autoPauseReason).toBe("locked");
    s = t.observe(s, T0 + 70 * SEC);
    s = t.setContext(s, T0 + 100 * SEC, ctx({ locked: false }));
    expect(s.status).toBe("paused");
    expect(s.buckets.undeterminedMs).toBe(60 * SEC); // locked period
    s = t.observe(s, T0 + 110 * SEC);
    expect(s.buckets.pausedMs).toBe(10 * SEC); // after unlock, still paused
    expect(s.buckets.elapsedMs).toBe(40 * SEC);
    expectPartition(s);
  });

  it("splits running time into focused and Perusall-foreground subsets using the previous context", () => {
    let s = t.start(t.initialTimerState(), T0, "s1");
    s = t.setContext(s, T0, ctx({ windowFocused: true, perusallForeground: true }));
    s = t.setContext(s, T0 + 20 * SEC, ctx({ windowFocused: true, perusallForeground: false }));
    s = t.setContext(s, T0 + 50 * SEC, ctx({ windowFocused: false, perusallForeground: false }));
    s = t.observe(s, T0 + 80 * SEC);
    expect(s.buckets.elapsedMs).toBe(80 * SEC);
    expect(s.buckets.focusedMs).toBe(50 * SEC);
    expect(s.buckets.foregroundMs).toBe(20 * SEC);
    expectPartition(s);
  });

  it("does not credit Perusall foreground time when no window has focus", () => {
    let s = t.setContext(t.start(t.initialTimerState(), T0, "s1"), T0, ctx({ windowFocused: false, perusallForeground: true }));
    s = t.observe(s, T0 + 30 * SEC);
    expect(s.buckets.foregroundMs).toBe(0);
  });

  it("marks sessions below the personal target as ended early", () => {
    const s = t.start(t.initialTimerState(), T0, "s1");
    expect(t.stop(s, T0 + 5 * MIN, 10 * MIN).finished?.status).toBe("ended-early");
    expect(t.stop(t.observe(s, T0 + 60 * SEC), T0 + 60 * SEC, 0).finished?.status).toBe("completed");
  });

  it("stop on an idle timer returns no session", () => {
    expect(t.stop(t.initialTimerState(), T0, 0).finished).toBeNull();
  });

  it("reset discards the session but keeps the activity context", () => {
    let s = t.setContext(t.start(t.initialTimerState(), T0, "s1"), T0, ctx({ perusallForeground: true }));
    s = t.reset(t.observe(s, T0 + 30 * SEC));
    expect(s.status).toBe("idle");
    expect(s.buckets.elapsedMs).toBe(0);
    expect(s.context.perusallForeground).toBe(true);
  });

  it("limits note length and ignores notes without a session", () => {
    const s = t.setNote(t.start(t.initialTimerState(), T0, "s1"), "x".repeat(900));
    expect(s.note).toHaveLength(t.MAX_NOTE_LENGTH);
    expect(t.setNote(t.initialTimerState(), "hi").note).toBe("");
  });

  it("bucketsAt projects without mutating state", () => {
    const s = t.start(t.initialTimerState(), T0, "s1");
    expect(t.bucketsAt(s, T0 + 12 * SEC).elapsedMs).toBe(12 * SEC);
    expect(s.buckets.elapsedMs).toBe(0);
    expect(t.segmentsAt(s, T0 + 12 * SEC)).toEqual([{ start: T0, end: T0 + 12 * SEC }]);
  });
});
