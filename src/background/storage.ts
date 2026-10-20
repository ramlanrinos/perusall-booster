// Thin, validated persistence layer over a chrome.storage-like area.
import { parseTimerState } from "../shared/model";
import { sanitizeSettings, type Settings } from "../shared/settings";
import { initialTimerState, type TimerState } from "../shared/timer";

/** The subset of chrome.storage.StorageArea that the extension uses (mockable in tests). */
export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const KEYS = {
  timer: "timer",
  timerBackup: "timer_corrupt_backup",
  settings: "settings",
  schemaVersion: "schemaVersion",
} as const;

export const SCHEMA_VERSION = 1;

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "StorageError";
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Store {
  constructor(private readonly area: StorageAreaLike) {}

  /** Loads the timer; a corrupt value is backed up and replaced by an idle timer. */
  async loadTimer(): Promise<{ state: TimerState; recovered: boolean }> {
    let raw: unknown;
    try {
      raw = (await this.area.get(KEYS.timer))[KEYS.timer];
    } catch (e) {
      throw new StorageError(`Could not read the timer: ${describe(e)}`, e);
    }
    const parsed = parseTimerState(raw);
    if (parsed) return { state: parsed, recovered: false };
    try {
      await this.area.set({ [KEYS.timerBackup]: raw, [KEYS.timer]: initialTimerState() });
    } catch {
      // Best effort: the in-memory idle state is still returned.
    }
    return { state: initialTimerState(), recovered: true };
  }

  async saveTimer(state: TimerState): Promise<void> {
    try {
      await this.area.set({ [KEYS.timer]: state, [KEYS.schemaVersion]: SCHEMA_VERSION });
    } catch (e) {
      throw new StorageError(`Could not save the timer: ${describe(e)}`, e);
    }
  }

  async loadSettings(): Promise<Settings> {
    try {
      return sanitizeSettings((await this.area.get(KEYS.settings))[KEYS.settings]);
    } catch (e) {
      throw new StorageError(`Could not read settings: ${describe(e)}`, e);
    }
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const clean = sanitizeSettings(settings);
    try {
      await this.area.set({ [KEYS.settings]: clean });
    } catch (e) {
      throw new StorageError(`Could not save settings: ${describe(e)}`, e);
    }
    return clean;
  }
}
