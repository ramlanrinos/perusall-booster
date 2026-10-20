import { describe, expect, it } from "vitest";
import { BackgroundService } from "../src/background/service";
import { KEYS, Store } from "../src/background/storage";
import type { PopupView, Response, SettingsResponse } from "../src/shared/messages";
import { evaluateReminders, localDateKey, nextBreakInMs, type Reminder } from "../src/shared/reminders";
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from "../src/shared/settings";
import * as t from "../src/shared/timer";
import { FakeAlarms, FakeClock, MemoryArea, MIN, SEC } from "./helpers";

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);

describe("reminder rules", () => {
  const running = t.start(t.initialTimerState(), T0, "s");
  const base = { state: running, today: "2026-10-20", dailyGoalNotifiedOn: null, todayMs: 0 };

  it("fires a break reminder once per interval of running time", () => {
    const s = settings({ breakReminderMinutes: 25, targetSessionMinutes: 0, dailyGoalMinutes: 0 });
    expect(evaluateReminders({ ...base, settings: s, elapsedMs: 24 * MIN }).due).toEqual([]);
    const r = evaluateReminders({ ...base, settings: s, elapsedMs: 25 * MIN });
    expect(r.due.map((d) => d.kind)).toEqual(["break"]);
    const again = evaluateReminders({ ...base, state: r.state, settings: s, elapsedMs: 26 * MIN });
    expect(again.due).toEqual([]);
    expect(evaluateReminders({ ...base, state: r.state, settings: s, elapsedMs: 50 * MIN }).due.map((d) => d.kind)).toEqual(["break"]);
  });

  it("a user pause restarts the break interval", () => {
    let s = running;
    for (let at = T0 + 30 * SEC; at <= T0 + 20 * MIN; at += 30 * SEC) s = t.observe(s, at); // heartbeats
    s = t.resume(t.pause(s, T0 + 20 * MIN), T0 + 25 * MIN);
    expect(s.reminders.lastBreakAtElapsedMs).toBe(20 * MIN);
    expect(nextBreakInMs(s, settings({ breakReminderMinutes: 25 }), 30 * MIN)).toBe(15 * MIN);
  });

  it("session goal and daily goal fire once", () => {
    const s = settings({ targetSessionMinutes: 30, dailyGoalMinutes: 60, breakReminderMinutes: 0 });
    const r = evaluateReminders({ ...base, settings: s, elapsedMs: 30 * MIN, todayMs: 61 * MIN });
    expect(r.due.map((d) => d.kind)).toEqual(["session-goal", "daily-goal"]);
    expect(r.dailyGoalNotifiedOn).toBe("2026-10-20");
    const again = evaluateReminders({ ...base, state: r.state, dailyGoalNotifiedOn: r.dailyGoalNotifiedOn, settings: s, elapsedMs: 40 * MIN, todayMs: 70 * MIN });
    expect(again.due).toEqual([]);
    const nextDay = evaluateReminders({ ...base, state: r.state, today: "2026-10-21", dailyGoalNotifiedOn: r.dailyGoalNotifiedOn, settings: s, elapsedMs: 40 * MIN, todayMs: 70 * MIN });
    expect(nextDay.due.map((d) => d.kind)).toEqual(["daily-goal"]);
  });

  it("respects notification switches but still advances the bookkeeping", () => {
    const s = settings({ breakReminderMinutes: 10, notifyBreaks: false, targetSessionMinutes: 10, notifySessionGoal: false });
    const r = evaluateReminders({ ...base, settings: s, elapsedMs: 10 * MIN });
    expect(r.due).toEqual([]);
    expect(r.state.reminders).toEqual({ lastBreakAtElapsedMs: 10 * MIN, sessionGoalNotified: true });
  });

  it("does nothing unless the timer is running", () => {
    const paused = t.pause(running, T0 + 40 * MIN);
    expect(evaluateReminders({ ...base, state: paused, settings: settings(), elapsedMs: 40 * MIN, todayMs: 999 * MIN }).due).toEqual([]);
  });

  it("formats local date keys", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});

describe("settings validation", () => {
  it("clamps, rounds and falls back per field", () => {
    expect(sanitizeSettings({ targetSessionMinutes: -5, dailyGoalMinutes: 99999, breakReminderMinutes: "20", notifyBreaks: "yes" })).toEqual({
      ...DEFAULT_SETTINGS, targetSessionMinutes: 0, dailyGoalMinutes: 1440, breakReminderMinutes: 20,
    });
    expect(sanitizeSettings({ targetSessionMinutes: 12.6 }).targetSessionMinutes).toBe(13);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ targetSessionMinutes: Number.NaN }).targetSessionMinutes).toBe(DEFAULT_SETTINGS.targetSessionMinutes);
  });
});

describe("reminders through the background service", () => {
  function setup() {
    const clock = new FakeClock();
    const area = new MemoryArea();
    const shown: Reminder[] = [];
    let failNotify = false;
    const service = new BackgroundService({
      store: new Store(area), alarms: new FakeAlarms(), now: clock.now, newId: () => "s",
      notify: (r) => { if (failNotify) throw new Error("blocked by OS"); shown.push(r); },
    });
    return { clock, area, shown, service, setFail: (v: boolean) => { failNotify = v; } };
  }
  const view = (r: Response): PopupView => { if (!r.ok) throw new Error(r.error); return r.view; };
  const ok = (r: SettingsResponse) => { if (!r.ok) throw new Error(r.error); return r.settings; };

  it("fires the break reminder on the heartbeat and reports the next one", async () => {
    const { clock, shown, service } = setup();
    ok(await service.handleSettings({ type: "saveSettings", settings: settings({ breakReminderMinutes: 1, targetSessionMinutes: 0, dailyGoalMinutes: 0 }) }));
    await service.handle({ type: "start" });
    clock.advance(30 * SEC); await service.tick();
    clock.advance(30 * SEC); await service.tick();
    expect(shown.map((r) => r.kind)).toEqual(["break"]);
    clock.advance(20 * SEC);
    expect(view(await service.handle({ type: "getState" })).nextBreakMs).toBe(40 * SEC);
  });

  it("remembers that today's goal was announced across worker restarts", async () => {
    const { clock, area, shown, service } = setup();
    ok(await service.handleSettings({ type: "saveSettings", settings: settings({ dailyGoalMinutes: 1, breakReminderMinutes: 0, targetSessionMinutes: 0 }) }));
    await service.handle({ type: "start" });
    for (let i = 0; i < 3; i++) { clock.advance(30 * SEC); await service.tick(); }
    expect(shown.filter((r) => r.kind === "daily-goal")).toHaveLength(1);
    expect(area.data[KEYS.dailyGoalNotifiedOn]).toBe(localDateKey(clock.now()));
  });

  it("a failing notification never breaks the timer", async () => {
    const { clock, service, setFail } = setup();
    ok(await service.handleSettings({ type: "saveSettings", settings: settings({ breakReminderMinutes: 1 }) }));
    setFail(true);
    await service.handle({ type: "start" });
    clock.advance(30 * SEC); await service.tick();
    clock.advance(30 * SEC); await service.tick();
    expect(view(await service.handle({ type: "getState" })).status).toBe("running");
  });

  it("saves sanitized settings and sends a test notification", async () => {
    const { shown, service } = setup();
    expect(ok(await service.handleSettings({ type: "saveSettings", settings: { ...DEFAULT_SETTINGS, dailyGoalMinutes: -3 } })).dailyGoalMinutes).toBe(0);
    ok(await service.handleSettings({ type: "testNotification" }));
    expect(shown).toHaveLength(1);
  });
});
