import type { SettingsRequest, SettingsResponse } from "../shared/messages";
import { DEFAULT_SETTINGS, LIMITS, type Settings } from "../shared/settings";

const form = document.getElementById("form") as HTMLFormElement;
const errorBox = document.getElementById("error") as HTMLElement;
const saved = document.getElementById("saved") as HTMLElement;
const numberFields = ["targetSessionMinutes", "dailyGoalMinutes", "breakReminderMinutes"] as const;
const boolFields = ["notifyBreaks", "notifySessionGoal", "notifyDailyGoal"] as const;
const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

async function send(request: SettingsRequest): Promise<Settings | null> {
  try {
    const res = (await chrome.runtime.sendMessage(request)) as SettingsResponse | undefined;
    if (!res) throw new Error("No response from the extension background.");
    if (!res.ok) throw new Error(res.error);
    errorBox.hidden = true;
    return res.settings;
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = e instanceof Error ? e.message : String(e);
    return null;
  }
}

function fill(s: Settings): void {
  for (const f of numberFields) input(f).value = String(s[f]);
  for (const f of boolFields) input(f).checked = s[f];
}

function read(): { settings: Settings; invalid: string[] } {
  const invalid: string[] = [];
  const settings = { ...DEFAULT_SETTINGS } as Settings;
  for (const f of numberFields) {
    const el = input(f);
    const n = Number(el.value);
    const { min, max } = LIMITS[f];
    const ok = el.value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
    el.setAttribute("aria-invalid", String(!ok));
    if (ok) settings[f] = n;
    else invalid.push(`${el.labels?.[0]?.textContent ?? f} must be a whole number from ${min} to ${max}.`);
  }
  for (const f of boolFields) settings[f] = input(f).checked;
  return { settings, invalid };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  saved.textContent = "";
  const { settings, invalid } = read();
  if (invalid.length) {
    errorBox.hidden = false;
    errorBox.textContent = invalid.join(" ");
    return;
  }
  const result = await send({ type: "saveSettings", settings });
  if (result) {
    fill(result);
    saved.textContent = "Saved ✓";
  }
});

document.getElementById("defaults")?.addEventListener("click", () => {
  fill({ ...DEFAULT_SETTINGS });
  saved.textContent = "Defaults restored. Press Save to keep them.";
});

document.getElementById("test")?.addEventListener("click", () => void send({ type: "testNotification" }));

void send({ type: "getSettings" }).then((s) => s && fill(s));
