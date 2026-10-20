import { sessionsToCsv } from "../shared/csv";
import type { HistoryRequest, HistoryResponse, HistoryView } from "../shared/messages";
import type { SessionRecord } from "../shared/model";
import { formatShort } from "../shared/time";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const rows = $("rows");
const errorBox = $("error");
const confirmDialog = $<HTMLDialogElement>("confirm");
let sessions: SessionRecord[] = [];

async function send(request: HistoryRequest): Promise<HistoryView | null> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as HistoryResponse | undefined;
    if (!res) throw new Error("No response from the extension background.");
    if (!res.ok) throw new Error(res.error);
    errorBox.hidden = true;
    return res.history;
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = e instanceof Error ? e.message : String(e);
    return null;
  }
}

function confirmAction(title: string, text: string, okLabel: string): Promise<boolean> {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
  });
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text; // textContent only: notes can never inject markup
  if (className) td.className = className;
  return td;
}

function render(view: HistoryView): void {
  sessions = view.sessions;
  const dropped = $("dropped");
  dropped.hidden = view.dropped === 0;
  dropped.textContent = `${view.dropped} stored record(s) were unreadable and are not shown.`;

  rows.replaceChildren(...sessions.map((s) => {
    const tr = document.createElement("tr");
    tr.append(
      cell(dateFmt.format(s.startedAt)),
      cell(`${timeFmt.format(s.startedAt)}–${timeFmt.format(s.endedAt)}`),
      cell(formatShort(s.elapsedMs), "num"),
      cell(formatShort(s.foregroundMs), "num"),
      cell(formatShort(s.pausedMs), "num"),
      cell(formatShort(s.undeterminedMs), "num"),
    );
    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${s.status}`;
    badge.textContent = s.status === "completed" ? "Completed" : "Ended early";
    status.append(badge);
    if (s.interruptions > 0) {
      const extra = document.createElement("div");
      extra.className = "small muted";
      extra.textContent = `${s.interruptions} automatic pause(s)`;
      status.append(extra);
    }
    tr.append(status, cell(s.note || "—", "note"));
    const actions = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-link";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete session from ${dateFmt.format(s.startedAt)} ${timeFmt.format(s.startedAt)}`);
    del.addEventListener("click", async () => {
      if (await confirmAction("Delete this session?", "It will be removed from your history on this device.", "Delete")) {
        const next = await send({ type: "deleteSession", id: s.id });
        if (next) render(next);
      }
    });
    actions.append(del);
    tr.append(actions);
    return tr;
  }));

  $("empty").hidden = sessions.length > 0;
  ($("export") as HTMLButtonElement).disabled = sessions.length === 0;
  ($("clear") as HTMLButtonElement).disabled = sessions.length === 0;
  const weekAgo = Date.now() - 7 * 86_400_000;
  $("sum-count").textContent = String(sessions.length);
  $("sum-elapsed").textContent = formatShort(sessions.reduce((a, s) => a + s.elapsedMs, 0));
  $("sum-foreground").textContent = formatShort(sessions.reduce((a, s) => a + s.foregroundMs, 0));
  $("sum-week").textContent = formatShort(sessions.filter((s) => s.startedAt >= weekAgo).reduce((a, s) => a + s.elapsedMs, 0));
}

$("export").addEventListener("click", () => {
  const blob = new Blob([sessionsToCsv(sessions)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  a.href = url;
  a.download = `perusall-booster-sessions-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

$("clear").addEventListener("click", async () => {
  if (await confirmAction("Clear all history?", `All ${sessions.length} saved session(s) will be permanently deleted from this browser. Export a CSV first if you want a copy.`, "Clear all")) {
    const next = await send({ type: "clearSessions" });
    if (next) render(next);
  }
});

void send({ type: "listSessions" }).then((v) => v && render(v));
