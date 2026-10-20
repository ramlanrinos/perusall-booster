import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

describe("manifest", () => {
  it("is Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("never injects scripts into web pages", () => {
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.permissions ?? []).not.toContain("scripting");
    expect(manifest.permissions ?? []).not.toContain("webRequest");
    expect(manifest.permissions ?? []).not.toContain("tabs");
  });

  it("only asks for host access to app.perusall.com", () => {
    for (const host of manifest.host_permissions ?? []) {
      expect(host).toBe("https://app.perusall.com/*");
    }
  });
});

describe("manifest assets", () => {
  it("references icons that exist and are PNG files", () => {
    const icons = { ...manifest.icons, ...manifest.action?.default_icon } as Record<string, string>;
    expect(Object.keys(icons).length).toBeGreaterThan(0);
    for (const path of Object.values(icons)) {
      const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    }
  });

  it("has a popup page that states the timer is separate from Perusall's records", () => {
    const html = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
    expect(manifest.action.default_popup).toBe("popup/popup.html");
    expect(html).toContain("separate from Perusall's official");
  });
});
