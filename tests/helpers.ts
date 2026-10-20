import type { StorageAreaLike } from "../src/background/storage";

/** In-memory chrome.storage.local stand-in; values are deep-copied like the real API. */
export class MemoryArea implements StorageAreaLike {
  data: Record<string, unknown> = {};
  failSet: Error | null = null;
  failGet: Error | null = null;
  setCalls = 0;

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    if (this.failGet) throw this.failGet;
    const out: Record<string, unknown> = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (k in this.data) out[k] = structuredClone(this.data[k]);
    }
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls++;
    if (this.failSet) throw this.failSet;
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete this.data[k];
  }
}

export class FakeAlarms {
  active = new Map<string, { periodInMinutes?: number; delayInMinutes?: number }>();
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void {
    this.active.set(name, info);
  }
  async clear(name: string): Promise<boolean> {
    return this.active.delete(name);
  }
}

export class FakeClock {
  constructor(public t = Date.UTC(2026, 9, 20, 9, 0, 0)) {}
  now = () => this.t;
  advance(ms: number): void { this.t += ms; }
}

export const SEC = 1000;
export const MIN = 60_000;
