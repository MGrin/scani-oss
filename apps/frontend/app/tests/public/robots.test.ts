/**
 * The app origin must not be indexable, on either host that serves this bundle.
 *
 * `app.scani.xyz` had none of this. Measured 2026-08-31, unauthenticated:
 *
 *     200  text/html  https://app.scani.xyz/robots.txt
 *     200  text/html  https://app.scani.xyz/
 *     200  text/html  https://app.scani.xyz/zz-not-real
 *
 * All three byte-identical (md5 ba585fe0…, 3992 b) — there was no `robots.txt`
 * in `public/`, so the request fell through the SPA rewrite and was answered
 * with `index.html`. **A crawler asking for the crawl rules got an HTML
 * document with a 200, which Google reads as "no robots.txt", i.e. crawl
 * everything.** The failure is silent in both directions: a
 * `curl -o /dev/null -w '%{http_code}'` check reads `200` and looks correct,
 * which is why the tests below assert on the CONTENT and not on a status.
 *
 * The policy itself is not new here. `nginx-security-headers.inc.template` has
 * carried `X-Robots-Tag: noindex, nofollow` since SC-561, under the comment
 * "Don't index the SPA". That covered the self-hosted image and nothing else —
 * `security-headers.test.ts` listed the header as an nginx-only exception
 * because "the Pages deployment of the same bundle is governed by its own host
 * config", and its own host config is `public/_headers`, which did not declare
 * it. Measured against production: zero `X-Robots-Tag` on any response.
 *
 * WHAT THIS COMBINATION DOES AND DOES NOT BUY, because the next reader will
 * assume more than it delivers. `Disallow: /` stops a compliant crawler
 * fetching the origin at all — so Googlebot never reads the `noindex` meta or
 * the header either. Those two are the backstop for crawlers that ignore
 * robots.txt, NOT a fix for a URL linked from somewhere else: a disallowed URL
 * that something links to can still surface as a bare URL with no snippet, and
 * nothing in this file prevents that. Removing the disallow to make the
 * `noindex` legible to Google is the documented alternative and is the WRONG
 * trade here: every path on this origin returns the same 200 SPA shell, and
 * the fallback cannot be scoped the way SC-837 scoped the landing's without
 * breaking the deep links client-side routing exists for. Inviting a crawl
 * would be inviting it into an unbounded soft-404 space.
 */

import { describe, expect, test } from 'bun:test';

const ROBOTS = await Bun.file(new URL('../../public/robots.txt', import.meta.url)).text();
const INDEX_HTML = await Bun.file(new URL('../../index.html', import.meta.url)).text();
const HEADERS_FILE = await Bun.file(new URL('../../public/_headers', import.meta.url)).text();
const NGINX_INCLUDE = await Bun.file(
  new URL('../../nginx-security-headers.inc.template', import.meta.url)
).text();

/**
 * Whether every crawler is disallowed from every path.
 *
 * Parsed by GROUP rather than grepped, because `Disallow: /` is equally
 * present in a file that only disallows one named bot — the shape that reads
 * as a fix and is not one.
 */
function disallowsEveryPath(robotsText: string): boolean {
  let inWildcardGroup = false;
  let sawWildcardGroup = false;
  let disallowedRoot = false;

  for (const raw of robotsText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'user-agent') {
      inWildcardGroup = value === '*';
      if (inWildcardGroup) sawWildcardGroup = true;
      continue;
    }
    if (!inWildcardGroup) continue;
    // An `Allow:` narrower than the disallow re-opens part of the origin.
    if (field === 'allow' && value !== '') return false;
    if (field === 'disallow' && value === '/') disallowedRoot = true;
  }

  return sawWildcardGroup && disallowedRoot;
}

/** The `content` of `<meta name="robots">`, or null when there is none. */
function robotsMetaContent(html: string): string | null {
  const match = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']\s*\/?>/i);
  return match ? (match[1] as string) : null;
}

/** The `/*` block of a `_headers` file. Mirrors `security-headers.test.ts`. */
function globalHeaders(source: string): Map<string, string> {
  const out = new Map<string, string>();
  let inGlobal = false;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inGlobal = line.trim() === '/*';
      continue;
    }
    if (!inGlobal) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

describe('public/robots.txt', () => {
  test('exists and is a robots file, not the SPA shell', () => {
    // The defect served `index.html` here. A crawler reads that as "no
    // robots.txt"; asserting the body is not markup is what discriminates,
    // since the status code reads 200 either way.
    expect(ROBOTS.trimStart().startsWith('<')).toBe(false);
    expect(ROBOTS.trim().length).toBeGreaterThan(0);
  });

  test('disallows every crawler from every path', () => {
    expect(disallowsEveryPath(ROBOTS)).toBe(true);
  });

  test('the group parse rejects a disallow scoped to one named bot', () => {
    // A control: without this, the test above passes on a file that leaves
    // every other crawler free, which is the failure it exists to catch.
    expect(disallowsEveryPath('User-agent: BadBot\nDisallow: /\n')).toBe(false);
    expect(disallowsEveryPath('User-agent: *\nAllow: /\n')).toBe(false);
    expect(disallowsEveryPath('User-agent: *\nDisallow: /\n')).toBe(true);
  });

  test('announces no sitemap, since nothing here should be crawled', () => {
    expect(/^\s*sitemap\s*:/im.test(ROBOTS)).toBe(false);
  });
});

describe('index.html carries the noindex backstop', () => {
  test('declares a robots meta', () => {
    expect(robotsMetaContent(INDEX_HTML)).not.toBeNull();
  });

  test('that meta is noindex and nofollow', () => {
    const content = (robotsMetaContent(INDEX_HTML) ?? '').toLowerCase();
    expect(content).toContain('noindex');
    expect(content).toContain('nofollow');
  });
});

describe('both hosts serving this bundle send X-Robots-Tag', () => {
  const HEADER = 'X-Robots-Tag';

  test('`_headers` declares it globally, so Pages sends it too', () => {
    // This is the half that was missing. nginx has sent it since SC-561; the
    // Pages deployment of the same bundle sent nothing.
    expect(globalHeaders(HEADERS_FILE).get(HEADER)).toBeDefined();
  });

  test('the two hosts declare the same value', () => {
    const fromPages = globalHeaders(HEADERS_FILE).get(HEADER);
    const fromNginx = NGINX_INCLUDE.match(/^\s*add_header\s+X-Robots-Tag\s+"([^"]*)"/m)?.[1];
    expect(`pages=${fromPages}`).toBe(`pages=${fromNginx}`);
  });

  test('that value is noindex and nofollow', () => {
    const value = (globalHeaders(HEADERS_FILE).get(HEADER) ?? '').toLowerCase();
    expect(value).toContain('noindex');
    expect(value).toContain('nofollow');
  });
});
