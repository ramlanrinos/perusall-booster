// The only Perusall-specific knowledge in the extension: which URLs are Perusall pages.
// Exact host match on HTTPS; look-alike hosts never match.
export const PERUSALL_ORIGIN = "https://app.perusall.com";
export const PERUSALL_MATCH = `${PERUSALL_ORIGIN}/*`;

export function isPerusallUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "app.perusall.com" && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}
