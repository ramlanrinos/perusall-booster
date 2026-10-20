// Derives the activity context from standard tab/window/idle APIs. It reads only:
//  - the URL of the active tab, which the browser reveals solely for app.perusall.com
//    (host permission), so other sites' URLs are never visible to the extension;
//  - whether a browser window has focus;
//  - whether the screen is locked.
import type { PerusallPresence } from "../shared/messages";
import { isPerusallUrl } from "../shared/perusall";
import type { ActivityContext } from "../shared/timer";

export type IdleStateLike = "active" | "idle" | "locked";

/** Browser queries, injected so the logic can be tested without a browser. */
export interface ActivityApis {
  /** URL of the active tab in the last-focused window (undefined when not visible to us). */
  activeTabUrl(): Promise<string | undefined>;
  /** Whether a browser window currently has focus. */
  windowFocused(): Promise<boolean>;
  /** Number of open Perusall tabs. */
  perusallTabCount(): Promise<number>;
  /** Operating-system idle state. */
  idleState(): Promise<IdleStateLike>;
  /** Whether the user has granted site access to app.perusall.com. */
  hasHostAccess(): Promise<boolean>;
}

export interface ActivitySnapshot {
  context: ActivityContext;
  perusall: PerusallPresence;
}

async function safe<T>(p: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await p();
  } catch {
    return fallback;
  }
}

export async function readActivity(apis: ActivityApis): Promise<ActivitySnapshot> {
  const [focused, url, count, idle, access] = await Promise.all([
    safe(() => apis.windowFocused(), false),
    safe(() => apis.activeTabUrl(), undefined),
    safe(() => apis.perusallTabCount(), 0),
    safe(() => apis.idleState(), "active" as IdleStateLike),
    safe(() => apis.hasHostAccess(), false),
  ]);
  const foreground = focused && isPerusallUrl(url);
  let perusall: PerusallPresence;
  if (!access) perusall = "unknown"; // site access withheld: we cannot tell
  else if (foreground) perusall = "foreground";
  else if (count > 0) perusall = "open";
  else perusall = "none";
  return {
    context: { windowFocused: focused, perusallForeground: access && foreground, locked: idle === "locked" },
    perusall,
  };
}
