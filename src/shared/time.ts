import type { Segment } from "./timer";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Local midnight at or before `t`. */
export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight after `t` (handles 23/25-hour DST days). */
export function startOfNextLocalDay(t: number): number {
  const d = new Date(startOfLocalDay(t));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Total length of the parts of `segments` that fall inside [from, to). */
export function overlapMs(segments: readonly Segment[], from: number, to: number): number {
  let total = 0;
  for (const seg of segments) {
    const a = Math.max(seg.start, from);
    const b = Math.min(seg.end, to);
    if (b > a) total += b - a;
  }
  return total;
}

/** "1:02:03" (hours:minutes:seconds), for the main timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** "0m", "45m", "1h 05m", for summaries. */
export function formatShort(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Percentage 0–100 of value/target; 0 when no target is set. */
export function percent(value: number, target: number): number {
  if (!(target > 0)) return 0;
  return Math.min(100, Math.round((value / target) * 100));
}
