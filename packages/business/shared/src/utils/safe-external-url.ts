/**
 * Validate a server-supplied external URL before rendering it into an
 * `<a href>` (or `<img src>`, `<iframe src>`, etc).
 *
 * `target="_blank" rel="noopener noreferrer"` blocks `window.opener`
 * tabnabbing but does NOT block the browser from executing
 * `javascript:`, `data:`, or `vbscript:` URIs. Any field that flows
 * from a database row, a 3rd-party integration response, or a user
 * profile into a rendered URL attribute must pass through this guard.
 *
 * Returns the original string if it parses as an `https:` or `http:`
 * URL, otherwise `undefined`. Caller is expected to omit the element
 * entirely when this returns `undefined` (don't fall back to a
 * placeholder href — that just trains users to click broken links).
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function safeExternalUrl(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  if (input !== input.trim()) return undefined;
  // Reject control characters (NUL, newline, tab, etc) and spaces — URL
  // parsers handle these inconsistently and they never appear in
  // legitimate links.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — defensive scrub of control chars an attacker might smuggle.
  if (/[\x00-\x20]/.test(input)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return undefined;
  return input;
}
