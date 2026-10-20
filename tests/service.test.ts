import { describe, expect, it } from "vitest";
import { BackgroundService, HEARTBEAT_ALARM } from "../src/background/service";
import { KEYS, Store } from "../src/background/storage";
import type { PopupView, Response } from "../src/shared/messages";
import { FakeAlarms, FakeClock, MemoryArea, MIN, SEC } from "./helpers";

function setup(area = new MemoryArea(), clock = new FakeClock()) {
  const alarms = new FakeAlarms();
  let n = 0;
  const service = new BackgroundService({ store: new Store(area), alarms, now: clock.now, newId: () => `id-${++n}`, notify: () => {} });
  return { area, clock, alarms, service };
}

function view(res: Response): PopupView {
  if (!res.ok) throw new Error(res.error);
  return res.view;
}

describe("background service", () => {
  it("runs a session and manages the heartbeat alarm", async () => {
    const { clock, alarms, service } = setup();
    expect(view(await service.handle({ type: "start" })).status).toBe("running");
    expect(alarms.active.has(HEARTBEAT_ALARM)).toBe(true);
    clock.advance(20 * SEC);
    await service.tick();
    clock.advance(10 * SEC);
    const v = view(await service.handle({ type: "stop" }));
    expect(v.status).toBe("idle");
    expect(alarms.active.has(HEARTBEAT_ALARM)).toBe(false);
  });

  it("popup reopening (repeated getState) never double counts", async () => {
    const { clock, service } = setup();
    await service.handle({ type: "start" });
    clock.advance(15 * SEC);
    const results = await Promise.all([1, 2, 3, 4].map(() => service.handle({ type: "getState" })));
    for (const r of results) expect(view(r).buckets.elapsedMs).toBe(15 * SEC);
  });

  it("serializes concurrent commands (double-clicked Start creates one session)", async () => {
    const { area, service } = setup();
    await Promise.all([service.handle({ type: "start" }), service.handle({ type: "start" })]);
    expect((area.data[KEYS.timer] as { sessionId: string }).sessionId).toBe("id-1");
  });

  it("survives a service-worker restart by reloading persisted state", async () => {
    const area = new MemoryArea();
    const clock = new FakeClock();
    const first = setup(area, clock).service;
    await first.handle({ type: "start" });
    clock.advance(25 * SEC);
    await first.tick();
    clock.advance(20 * SEC);
    const second = setup(area, clock).service; // worker was terminated and restarted
    const v = view(await second.handle({ type: "getState" }));
    expect(v.status).toBe("running");
    expect(v.buckets.elapsedMs).toBe(45 * SEC);
  });

  it("classifies a browser restart gap as not determined and auto-pauses", async () => {
    const area = new MemoryArea();
    const clock = new FakeClock();
    await setup(area, clock).service.handle({ type: "start" });
    clock.advance(20 * SEC);
    await setup(area, clock).service.tick();
    clock.advance(2 * 60 * MIN); // browser closed for 2 hours
    const { service, alarms } = setup(area, clock);
    await service.startup();
    const v = view(await service.handle({ type: "getState" }));
    expect(v.status).toBe("paused");
    expect(v.autoPauseReason).toBe("sleep-or-closed");
    expect(v.buckets.elapsedMs).toBe(20 * SEC);
    expect(v.buckets.undeterminedMs).toBe(2 * 60 * MIN);
    expect(alarms.active.has(HEARTBEAT_ALARM)).toBe(true);
  });

  it("reports storage write failures instead of losing them silently", async () => {
    const { area, service } = setup();
    area.failSet = new Error("QUOTA_BYTES quota exceeded");
    const res = await service.handle({ type: "start" });
    expect(res.ok).toBe(false);
    area.failSet = null;
    const v = view(await service.handle({ type: "getState" }));
    expect(v.status).toBe("idle"); // the failed start was not half-applied
  });

  it("recovers from corrupt stored timer data and keeps a backup", async () => {
    const area = new MemoryArea();
    area.data[KEYS.timer] = { status: "running", buckets: "garbage" };
    const { service } = setup(area);
    const v = view(await service.handle({ type: "getState" }));
    expect(v.status).toBe("idle");
    expect(v.storageError).toMatch(/unreadable/);
    expect(area.data[KEYS.timerBackup]).toEqual({ status: "running", buckets: "garbage" });
  });

  it("saves the note with the session and resets discard without saving", async () => {
    const { clock, service, area } = setup();
    await service.handle({ type: "start" });
    await service.handle({ type: "setNote", note: "Week 6 reading" });
    clock.advance(5 * SEC);
    expect(view(await service.handle({ type: "getState" })).note).toBe("Week 6 reading");
    await service.handle({ type: "reset" });
    expect(view(await service.handle({ type: "getState" })).status).toBe("idle");
    expect((area.data[KEYS.timer] as { note: string }).note).toBe("");
  });
});
