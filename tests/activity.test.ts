import { describe, expect, it } from "vitest";
import { readActivity, type ActivityApis, type IdleStateLike } from "../src/background/activity";
import { BackgroundService } from "../src/background/service";
import { Store } from "../src/background/storage";
import type { PopupView, Response } from "../src/shared/messages";
import { isPerusallUrl } from "../src/shared/perusall";
import { FakeAlarms, FakeClock, MemoryArea, SEC } from "./helpers";

function apis(over: Partial<{ url: string | undefined; focused: boolean; count: number; idle: IdleStateLike; access: boolean; throws: boolean }> = {}): ActivityApis {
  const o = { url: undefined, focused: true, count: 0, idle: "active" as IdleStateLike, access: true, throws: false, ...over };
  const v = <T>(x: T) => (o.throws ? Promise.reject(new Error("api unavailable")) : Promise.resolve(x));
  return {
    activeTabUrl: () => v(o.url),
    windowFocused: () => v(o.focused),
    perusallTabCount: () => v(o.count),
    idleState: () => v(o.idle),
    hasHostAccess: () => v(o.access),
  };
}

describe("Perusall URL matching", () => {
  it.each([
    ["https://app.perusall.com/courses/:course/documents/:doc", true],
    ["https://app.perusall.com/", true],
    ["https://app.perusall.com:443/home", true],
    ["http://app.perusall.com/courses", false],
    ["https://perusall.com/", false],
    ["https://app.perusall.com.evil.example/", false],
    ["https://evil.example/app.perusall.com/", false],
    ["https://xapp.perusall.com/", false],
    ["https://app.perusall.com:8443/", false],
    ["chrome://extensions", false],
    ["not a url", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isPerusallUrl(url)).toBe(expected);
  });
});

describe("activity context", () => {
  it("Perusall active in a focused window is foreground", async () => {
    const r = await readActivity(apis({ url: "https://app.perusall.com/courses/:course/documents/:doc", count: 1 }));
    expect(r.perusall).toBe("foreground");
    expect(r.context).toEqual({ windowFocused: true, perusallForeground: true, locked: false });
  });

  it("Perusall open in another tab is 'open', not foreground", async () => {
    const r = await readActivity(apis({ url: undefined, count: 2 }));
    expect(r.perusall).toBe("open");
    expect(r.context.perusallForeground).toBe(false);
  });

  it("an unfocused browser is never foreground", async () => {
    const r = await readActivity(apis({ url: "https://app.perusall.com/x", focused: false, count: 1 }));
    expect(r.perusall).toBe("open");
    expect(r.context).toMatchObject({ windowFocused: false, perusallForeground: false });
  });

  it("unrelated sites are ignored", async () => {
    const r = await readActivity(apis({ url: "https://news.example.com/", count: 0 }));
    expect(r.perusall).toBe("none");
    expect(r.context.perusallForeground).toBe(false);
  });

  it("without site access the presence is unknown and never counted as foreground", async () => {
    const r = await readActivity(apis({ url: "https://app.perusall.com/x", access: false, count: 1 }));
    expect(r.perusall).toBe("unknown");
    expect(r.context.perusallForeground).toBe(false);
  });

  it("only a locked screen is treated as locked (idle reading is normal)", async () => {
    expect((await readActivity(apis({ idle: "idle" }))).context.locked).toBe(false);
    expect((await readActivity(apis({ idle: "locked" }))).context.locked).toBe(true);
  });

  it("API failures fall back to the most conservative values", async () => {
    const r = await readActivity(apis({ throws: true }));
    expect(r.perusall).toBe("unknown");
    expect(r.context).toEqual({ windowFocused: false, perusallForeground: false, locked: false });
  });
});

describe("activity indicators through the background service", () => {
  it("accrues foreground and focused time from context changes, separately from elapsed", async () => {
    const clock = new FakeClock();
    const service = new BackgroundService({ store: new Store(new MemoryArea()), alarms: new FakeAlarms(), now: clock.now, newId: () => "s" });
    await service.handle({ type: "start" });
    await service.updateContext({ windowFocused: true, perusallForeground: true, locked: false }, "foreground");
    clock.advance(20 * SEC);
    await service.updateContext({ windowFocused: true, perusallForeground: false, locked: false }, "open"); // switched tab
    clock.advance(10 * SEC);
    await service.updateContext({ windowFocused: false, perusallForeground: false, locked: false }, "open"); // other app
    clock.advance(15 * SEC);
    const res: Response = await service.handle({ type: "getState" });
    const v = (res as { ok: true; view: PopupView }).view;
    expect(v.buckets.elapsedMs).toBe(45 * SEC);
    expect(v.buckets.focusedMs).toBe(30 * SEC);
    expect(v.buckets.foregroundMs).toBe(20 * SEC);
    expect(v.perusall).toBe("open");
  });
});
