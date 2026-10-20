import type { SessionRecord } from "./model";

const HEADER = [
  "date", "start_time", "end_time", "timer_elapsed_min", "perusall_foreground_min", "browser_focused_min",
  "paused_min", "not_determined_min", "interruptions", "status", "note",
];

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const minutes = (ms: number) => (ms / 60_000).toFixed(1);

/**
 * Quotes a CSV field (RFC 4180) and neutralises spreadsheet formulas: a cell starting with
 * = + - @ or a tab/CR is prefixed with an apostrophe so it is shown as text, not executed.
 */
export function csvField(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v) || v !== value) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** CSV of the given sessions (oldest first). Uses CRLF line endings for spreadsheet compatibility. */
export function sessionsToCsv(sessions: readonly SessionRecord[]): string {
  const rows = [...sessions].sort((a, b) => a.startedAt - b.startedAt).map((s) => [
    localDate(s.startedAt), localTime(s.startedAt), localTime(s.endedAt),
    minutes(s.elapsedMs), minutes(s.foregroundMs), minutes(s.focusedMs),
    minutes(s.pausedMs), minutes(s.undeterminedMs), String(s.interruptions), s.status, s.note,
  ].map(csvField).join(","));
  return [HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}
