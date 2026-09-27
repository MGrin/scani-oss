/**
 * The host a shared institution is keyed by (SC-1354): lowercase, without a
 * scheme, `www.`, port, path, query or trailing dot. `null` for anything that
 * is not a public site name — no dot, an IP literal, a non-web scheme — so the
 * catalogue can only ever be keyed by a real site.
 */
export function siteHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}
