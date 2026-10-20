import { describe, expect, it } from "vitest";
import { BackgroundService } from "../src/background/service";
import { KEYS, Store } from "../src/background/storage";
import { csvField, sessionsToCsv } from "../src/shared/csv";
import type { HistoryResponse, PopupView, Response } from "../src/shared/messages";
import { MAX_SESSIONS, parseSessionList, type SessionRecord } from "../src/shared/model";
import { FakeAlarms, FakeClock, MemoryArea, MIN, SEC } from "./helpers";

function setup(area = new MemoryArea(), clock = new FakeClock()) {
  let n = 0;
  const service = new BackgroundService({ store: new Store(area), alarms: new FakeAlarms(), now: clock.now, newId: () => `id-${++n}`, notify: () => {} });
  return { area, clock, service };
}
const view = (r: Response): PopupView => { if (!r.ok) throw new Error(r.error); return r.view; };
const history = (r: HistoryResponse) => { if (!r.ok) throw new Error(r.error); return r.history; };

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  const startedAt = over.startedAt ?? Date.UTC(2026, 9, 19, 10, 0, 0);
  return {
    id: "r1", startedAt, endedAt: startedAt + 30 * MIN, elapsedMs: 25 * MIN, pausedMs: 5 * MIN, undeterminedMs: 0,
    focusedMs: 20 * MIN, foregroundMs: 15 * MIN, interruptions: 0,
    segments: [{ start: startedAt, end: startedAt + 25 * MIN }], note: "", status: "completed", ...over,
  };
}

describe("session history", () => {
  it("stop saves a complete record with the note", async () => {
    const { clock, service } = setup();
    await service.handle({ type: "start" });
    clock.advance(20 * SEC);
    await service.tick();
    clock.advance(10 * SEC);
    await service.handle({ type: "stop", note: "Ch. 4" });
    const h = history(await service.handleHistory({ type: "listSessions" }));
    expect(h.sessions).toHaveLength(1);
    const s = h.sessions[0]!;
    expect(s.elapsedMs).toBe(30 * SEC);
    expect(s.note).toBe("Ch. 4");
    expect(s.status).toBe("ended-early"); // default personal target is 30 min
    expect(s.segments).toHaveLength(1);
  });

  it("does not lose the session if saving history fails: stop fails and the timer keeps running", async () => {
    const { area, clock, service } = setup();
    await service.handle({ type: "start" });
    clock.advance(10 * SEC);
    area.failSet = new Error("disk full");
    const res = await service.handle({ type: "stop" });
    expect(res.ok).toBe(false);
    area.failSet = null;
    const v = view(await service.handle({ type: "getState" }));
    expect(v.status).toBe("running");
    expect(v.buckets.elapsedMs).toBe(10 * SEC);
  });

  it("today's total includes saved sessions and only the part after local midnight", async () => {
    const clock = new FakeClock(new Date(2026, 9, 20, 0, 10, 0).getTime()); // 00:10 local
    const area = new MemoryArea();
    const yesterdayLate = new Date(2026, 9, 19, 23, 50, 0).getTime();
    area.data[KEYS.sessions] = [record({ id: "x", startedAt: yesterdayLate, endedAt: yesterdayLate + 20 * MIN, segments: [{ start: yesterdayLate, end: yesterdayLate + 20 * MIN }], elapsedMs: 20 * MIN, focusedMs: 0, foregroundMs: 0, pausedMs: 0 })];
    const { service } = setup(area, clock);
    await service.handle({ type: "start" });
    clock.advance(25 * SEC);
    const v = view(await service.handle({ type: "getState" }));
    expect(v.todayMs).toBe(10 * MIN + 25 * SEC);
  });

  it("deletes one session and clears all", async () => {
    const area = new MemoryArea();
    area.data[KEYS.sessions] = [record({ id: "a" }), record({ id: "b", startedAt: Date.UTC(2026, 9, 18) })];
    const { service } = setup(area);
    expect(history(await service.handleHistory({ type: "deleteSession", id: "a" })).sessions.map((s) => s.id)).toEqual(["b"]);
    expect(history(await service.handleHistory({ type: "clearSessions" })).sessions).toEqual([]);
    expect(area.data[KEYS.sessions]).toEqual([]);
  });

  it("reports read failures to the history page", async () => {
    const area = new MemoryArea();
    area.failGet = new Error("IO error");
    const res = await setup(area).service.handleHistory({ type: "listSessions" });
    expect(res.ok).toBe(false);
  });

  it("validates stored lists: drops invalid and duplicate records, sorts newest first", () => {
    const older = record({ id: "old", startedAt: Date.UTC(2026, 0, 1) });
    const newer = record({ id: "new", startedAt: Date.UTC(2026, 5, 1) });
    const { sessions, dropped } = parseSessionList([
      older, newer, { ...newer }, { id: "bad", startedAt: "yesterday" },
      record({ id: "neg", elapsedMs: -5 }), record({ id: "subset", foregroundMs: 99 * MIN }), null,
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["new", "old"]);
    expect(dropped).toBe(5);
    expect(parseSessionList("not a list")).toEqual({ sessions: [], dropped: 1 });
  });

  it("strips unknown fields so nothing unexpected is kept", () => {
    const { sessions } = parseSessionList([{ ...record(), url: "https://example.org/private", title: "secret doc" }]);
    expect(Object.keys(sessions[0]!)).not.toContain("url");
    expect(Object.keys(sessions[0]!)).not.toContain("title");
  });

  it(`keeps at most ${MAX_SESSIONS} sessions`, async () => {
    const area = new MemoryArea();
    area.data[KEYS.sessions] = Array.from({ length: MAX_SESSIONS }, (_, i) => record({ id: `s${i}`, startedAt: Date.UTC(2025, 0, 1) + i * MIN }));
    const store = new Store(area);
    await store.addSession(record({ id: "newest", startedAt: Date.UTC(2026, 0, 1) }));
    const { sessions } = await store.loadSessions();
    expect(sessions).toHaveLength(MAX_SESSIONS);
    expect(sessions[0]!.id).toBe("newest");
    expect(sessions.some((s) => s.id === "s0")).toBe(false); // oldest dropped
  });
});

describe("CSV export", () => {
  it("quotes special characters and neutralises spreadsheet formulas", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField("+1")).toBe('"\'+1"');
    expect(csvField("@cmd")).toBe('"\'@cmd"');
  });

  it("exports a header and one row per session, oldest first, in minutes", () => {
    const csv = sessionsToCsv([
      record({ id: "b", startedAt: Date.UTC(2026, 9, 19, 12), note: "second" }),
      record({ id: "a", startedAt: Date.UTC(2026, 9, 18, 12), note: "first, with comma" }),
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("date,start_time,end_time,timer_elapsed_min,perusall_foreground_min,browser_focused_min,paused_min,not_determined_min,interruptions,status,note");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"first, with comma"');
    expect(lines[1]).toContain(",25.0,15.0,20.0,5.0,0.0,0,completed,");
    expect(lines[2]!.endsWith(",second")).toBe(true);
    expect(csv).not.toContain("r1"); // internal ids are not exported
  });
});
