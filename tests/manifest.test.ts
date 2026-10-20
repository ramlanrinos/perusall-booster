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
