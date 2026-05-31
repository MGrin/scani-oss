import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AnalyticsApp } from './events';

// Signed payload embedded in every email-tracking URL. The endpoints in
// the data-provider decode + verify it, so it must be tamper-proof — an
// attacker rewriting `e` (recipient) would otherwise poison analytics.
export interface TrackingPayload {
  m: string; // messageId
  t: string; // template name
  a: AnalyticsApp; // originating surface
  e: string; // recipient email
  u?: string; // destination URL (click tokens only)
}

const b64urlEncode = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signTrackingToken(payload: TrackingPayload, secret: string): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64urlEncode(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyTrackingToken(token: string, secret: string): TrackingPayload | null {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64urlEncode(createHmac('sha256', secret).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as TrackingPayload;
    if (!parsed.m || !parsed.e || !parsed.t || !parsed.a) return null;
    return parsed;
  } catch {
    return null;
  }
}

// 1x1 transparent GIF returned by the open-tracking pixel endpoint.
export const TRANSPARENT_GIF: Uint8Array = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

interface RewriteOptions {
  html: string;
  messageId: string;
  recipient: string;
  template: string;
  app: AnalyticsApp;
  baseUrl: string;
  secret: string;
}

// Inverse of the email templates' escapeHtml. An href value parsed out of the
// HTML is still entity-encoded (`&` arrives as `&amp;`), so it must be decoded
// before it becomes the redirect destination — otherwise the /e/c/ handler
// 302s to `?a=1&amp;b=2` and downstream parsers see a param named `amp;b`.
const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// Rewrites http(s) links to route through the click-tracking endpoint and
// appends an open-tracking pixel. Returns the HTML untouched if it has no
// recognisable links and no </body> — defensive, never throws.
export function rewriteEmailHtml(opts: RewriteOptions): string {
  const { html, messageId, recipient, template, app, baseUrl, secret } = opts;
  const base = baseUrl.replace(/\/+$/, '');
  const sign = (u?: string): string =>
    signTrackingToken(
      { m: messageId, t: template, a: app, e: recipient, ...(u ? { u } : {}) },
      secret
    );

  let rewritten = html.replace(
    /(<a\b[^>]*?\shref=)(["'])(https?:\/\/[^"']+)\2/gi,
    (_match, prefix: string, quote: string, url: string) =>
      `${prefix}${quote}${base}/e/c/${sign(decodeHtmlEntities(url))}${quote}`
  );

  const pixel = `<img src="${base}/e/o/${sign()}" alt="" width="1" height="1" style="display:none" />`;
  rewritten = rewritten.includes('</body>')
    ? rewritten.replace('</body>', `${pixel}</body>`)
    : `${rewritten}${pixel}`;
  return rewritten;
}
