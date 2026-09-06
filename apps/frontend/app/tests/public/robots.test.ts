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
 *
 * ALL OF THE ABOVE IS ABOUT THE DEFAULT, AND THE DEFAULT IS STILL THIS.
 * SC-1108 added `ROBOTS_POLICY` because the same bundle is also served to a
 * public demo with no auth wall, which inherited this exclusion and the
 * sentence justifying it. The last three blocks in this file describe that
 * knob, including the one thing the paragraph above gets to keep being right
 * about: the soft-404 space is real, so the opt-in offers the ROOT DOCUMENT
 * and not the origin. Read them before concluding this file says a crawl is
 * never allowed.
 */

import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROBOTS = await Bun.file(new URL('../../public/robots.txt', import.meta.url)).text();
const INDEX_HTML = await Bun.file(new URL('../../index.html', import.meta.url)).text();
const HEADERS_FILE = await Bun.file(new URL('../../public/_headers', import.meta.url)).text();
const NGINX_INCLUDE = await Bun.file(
  new URL('../../nginx-security-headers.inc.template', import.meta.url)
).text();
const DOCKERFILE = await Bun.file(new URL('../../Dockerfile', import.meta.url)).text();
const POLICY_SCRIPT_URL = new URL('../../docker-robots-policy.envsh', import.meta.url);
const POLICY_SCRIPT = await Bun.file(POLICY_SCRIPT_URL).text();
const ROBOTS_INDEX_ROOT = await Bun.file(
  new URL('../../nginx-robots-index-root.txt', import.meta.url)
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

/**
 * The `Allow:` and `Disallow:` values of the `User-agent: *` group.
 *
 * Same group-aware parse as above rather than a grep, for the same reason: a
 * line is only worth reading once you know which agent it binds.
 */
function wildcardGroup(robotsText: string): { allow: string[]; disallow: string[] } {
  const allow: string[] = [];
  const disallow: string[] = [];
  let inWildcardGroup = false;

  for (const raw of robotsText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'user-agent') {
      inWildcardGroup = value === '*';
      continue;
    }
    if (!inWildcardGroup) continue;
    if (field === 'allow') allow.push(value);
    if (field === 'disallow') disallow.push(value);
  }

  return { allow, disallow };
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

  test('the two hosts declare the same value BY DEFAULT', () => {
    // nginx parameterises this one now (SC-1108), so the comparison is
    // against the Dockerfile's default rather than against a literal in the
    // include — the same shape `connect-src` already has. The invariant is
    // unchanged in substance: an image nobody has configured sends what
    // `_headers` sends. What it no longer asserts is that the two can never
    // differ, because making them differ, on one host, deliberately, is the
    // whole feature.
    const fromPages = globalHeaders(HEADERS_FILE).get(HEADER);
    const nginxValue = NGINX_INCLUDE.match(/^\s*add_header\s+X-Robots-Tag\s+"([^"]*)"/m)?.[1];
    const fromDockerfile = DOCKERFILE.match(/^ENV ROBOTS_DIRECTIVE="([^"]*)"/m)?.[1];

    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text nginx's envsubst looks for, not an unfinished template literal — asserting on it is the point
    expect(nginxValue).toBe('${ROBOTS_DIRECTIVE}');
    expect(`pages=${fromPages}`).toBe(`pages=${fromDockerfile}`);
  });

  test('that value is noindex and nofollow', () => {
    const value = (globalHeaders(HEADERS_FILE).get(HEADER) ?? '').toLowerCase();
    expect(value).toContain('noindex');
    expect(value).toContain('nofollow');
  });
});

/**
 * The runtime robots posture (SC-1108).
 *
 * Everything above describes the DEFAULT, and the default is unchanged: this
 * bundle is served to an auth wall at one host and to a public demo at
 * another, and the demo inherited the auth wall's exclusion — justified, in
 * the file it inherited, by a sentence about an auth wall it does not have.
 *
 * The two hosts do not share a config surface. `app.scani.xyz` is a static
 * host reading `public/_headers`; the demo is this repo's nginx image, whose
 * header set comes from `nginx-security-headers.inc.template`. What they DO
 * share is the build artefact — `public/robots.txt` and the
 * `<meta name="robots">` in `index.html` — so those two are the ones a split
 * has to reach, and reaching them at container start rather than at build
 * time is what keeps `deploy-demo.sh`'s invariant intact: the demo must run
 * the published image unchanged, so the split cannot be a build target.
 *
 * ONE KNOB, THREE MECHANISMS, and that is the point rather than an
 * implementation detail. A crawler takes the most restrictive of
 * `robots.txt`, the meta and `X-Robots-Tag`, so a posture that moves one or
 * two of them is a deployment that reads as configured and is not — which is
 * the exact state SC-1108 was filed about, one origin over.
 */
describe('ROBOTS_POLICY: the default is the behaviour that was already here', () => {
  test('the bundle still ships the disallow-everything robots.txt', () => {
    // The alternate file is a container-start substitution. If this ever
    // stops being true, every host serving this bundle became crawlable at
    // once, including the auth-walled one.
    expect(disallowsEveryPath(ROBOTS)).toBe(true);
  });

  test('the bundle still ships the noindex meta', () => {
    expect((robotsMetaContent(INDEX_HTML) ?? '').toLowerCase()).toContain('noindex');
  });

  test('the image defaults the policy to noindex', () => {
    expect(DOCKERFILE).toContain('ENV ROBOTS_POLICY=noindex');
  });

  test('the derived header variable is declared, so removing the script fails CLOSED', () => {
    // envsubst only substitutes variables that EXIST. Undeclared, the header
    // would ship the literal `${ROBOTS_DIRECTIVE}` — not a directive any
    // crawler reads, i.e. indexable. Declared, the same accident is a
    // `noindex` header.
    expect(DOCKERFILE).toContain('ENV ROBOTS_DIRECTIVE="noindex, nofollow"');
  });
});

describe('ROBOTS_POLICY: the image can be told to offer the root', () => {
  test('the alternate robots.txt is a robots file, not markup', () => {
    expect(ROBOTS_INDEX_ROOT.trimStart().startsWith('<')).toBe(false);
    expect(ROBOTS_INDEX_ROOT.trim().length).toBeGreaterThan(0);
  });

  test('it does not disallow every path — otherwise the policy is a no-op', () => {
    // The control for the test below: a file that still disallowed everything
    // would satisfy "the root is not over-exposed" trivially and buy nothing.
    expect(disallowsEveryPath(ROBOTS_INDEX_ROOT)).toBe(false);
  });

  test('it anchors the root allow, so the SPA fallback space stays closed', () => {
    // Every path on this origin returns the same 200 shell, so an unanchored
    // `Allow: /` offers a crawler an unbounded soft-404 space rather than a
    // site. `/$` matches the root document and nothing else.
    const group = wildcardGroup(ROBOTS_INDEX_ROOT);
    expect(group.allow).toContain('/$');
    expect(group.allow).not.toContain('/');
    expect(group.disallow).toContain('/');
  });

  test('it allows the bundle, without which an indexed root is an empty div', () => {
    // This is client-rendered: blocking `/assets/` would index a document
    // with nothing in it, which is worse than not being indexed and would
    // defeat the only reason to allow the crawl.
    expect(wildcardGroup(ROBOTS_INDEX_ROOT).allow).toContain('/assets/');
  });

  test('it announces no sitemap, because this origin generates none', () => {
    expect(/^\s*sitemap\s*:/im.test(ROBOTS_INDEX_ROOT)).toBe(false);
  });

  test('it is NOT under public/, so no static host ever publishes it', () => {
    // Under the default policy it must be unreachable. A second robots file
    // sitting beside the real one is a config file describing rules the
    // deployment is not using — the reason the image deletes `_headers`.
    const inBundle = Bun.file(new URL('../../public/nginx-robots-index-root.txt', import.meta.url));
    expect(inBundle.size).toBe(0);
    expect(DOCKERFILE).toContain(
      'COPY apps/frontend/app/nginx-robots-index-root.txt /etc/nginx/robots-index-root.txt'
    );
  });
});

describe('the policy script is wired the one way the entrypoint will honour', () => {
  test('it is installed as `.envsh`, before the envsubst pass', () => {
    // The image entrypoint SOURCES `*.envsh` and EXECUTES `*.sh`. Only the
    // sourced form can export `ROBOTS_DIRECTIVE` into the envsubst that
    // follows, so the suffix is behaviour and not naming. `18-` sorts after
    // the image's own `15-local-resolvers.envsh` and before
    // `20-envsubst-on-templates.sh`.
    expect(DOCKERFILE).toContain(
      'COPY apps/frontend/app/docker-robots-policy.envsh /docker-entrypoint.d/18-robots-policy.envsh'
    );
  });

  test('it is executable, or the entrypoint IGNORES it in one silent line', () => {
    // `if [ -x "$f" ]; then . "$f"; else "Ignoring $f, not executable"`. A
    // mode of 644 does not fail the build, does not fail the boot and does
    // not fail a request — the container simply serves the default posture
    // while the operator's env var says otherwise.
    const mode = statSync(fileURLToPath(POLICY_SCRIPT_URL)).mode;
    expect(`executable=${(mode & 0o111) !== 0}`).toBe('executable=true');
  });

  test('nginx takes the header from the derived variable', () => {
    expect(NGINX_INCLUDE).toContain('add_header X-Robots-Tag "${ROBOTS_DIRECTIVE}" always;');
  });

  test('it refuses an unrecognised policy rather than guessing a direction', () => {
    // Coercing to `noindex` leaves an operator who opted in believing they
    // did; coercing to `index` publishes an origin nobody chose to publish.
    expect(POLICY_SCRIPT).toContain('is not a value this image knows');
    expect(POLICY_SCRIPT).toMatch(/\*\)[\s\S]{0,400}exit 1/);
  });
});

describe("the script's rewrite pattern still matches the document it rewrites", () => {
  /**
   * The one cross-file coupling here, and the one that would otherwise fail
   * at container start in production rather than in CI: the script rewrites
   * `index.html` with a `sed` pattern, and `sed` that matches nothing exits
   * 0. The script has its own read-back guard, but that guard runs on a
   * booting container — this runs on the branch.
   *
   * The pattern is READ OUT OF THE SCRIPT rather than restated. A restated
   * copy drifts with the thing it is meant to be checking, and then agrees
   * with itself forever.
   */
  const sedPattern = POLICY_SCRIPT.match(/sed -i 's\|(<meta[^|]*)\|/)?.[1];

  test('the pattern is still extractable from the script', () => {
    // Without this the two tests below pass vacuously on `undefined`.
    expect(typeof sedPattern).toBe('string');
  });

  test('index.html carries exactly one robots meta, as the script asserts', () => {
    // The script refuses to start unless `grep -c 'name="robots"'` is 1.
    expect((INDEX_HTML.match(/name="robots"/g) ?? []).length).toBe(1);
  });

  test('the pattern matches the meta as index.html currently spells it', () => {
    expect(new RegExp(sedPattern ?? 'zz-no-pattern-extracted').test(INDEX_HTML)).toBe(true);
  });
});
