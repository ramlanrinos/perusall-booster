// Checks WCAG 2.x contrast of the design tokens in both colour schemes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
const block = (re: RegExp) => Object.fromEntries([...(re.exec(css)?.[1] ?? "").matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
const light = block(/:root\s*\{([^}]*)\}/);
const dark = { ...light, ...block(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

// [foreground, background] token pairs used for text.
const PAIRS: Array<[string, string]> = [
  ["text", "bg"], ["text", "surface"], ["text", "surface-2"], ["text-muted", "surface"], ["text-muted", "bg"],
  ["text-muted", "surface-2"], ["accent", "surface"], ["accent", "accent-soft"], ["accent-contrast", "accent"],
  ["gold", "gold-soft"], ["text", "gold-soft"], ["danger", "surface"], ["danger", "danger-soft"],
];

describe.each([["light", light], ["dark", dark]] as const)("%s theme contrast", (_name, tokens) => {
  it.each(PAIRS)("%s on %s is at least 4.5:1 (WCAG AA)", (fg, bg) => {
    expect(tokens[fg], fg).toBeDefined();
    expect(tokens[bg], bg).toBeDefined();
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
