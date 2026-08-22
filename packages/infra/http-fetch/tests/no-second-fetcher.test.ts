import { describe, expect, test } from 'bun:test';

/**
 * SC-208, second attempt. **The guard has to be where the traffic is.**
 *
 * The first version of the SSRF fix was correct and landed in a file nothing
 * imports. `main` carried THREE byte-identical copies of the bounded fetcher —
 * `apps/backend/api/src/lib/`, `apps/backend/data-provider/src/lib/`, and this
 * package — and only the package is reached by anything: `institutions.ts` and
 * `og.ts` both `import { fetchHtmlBounded } from '@scani/http-fetch'`. So a
 * hardened copy sat beside a live vulnerable one for the length of a review.
 *
 * The prediction was already written into that PR:
 *
 *   > a private-address check that exists twice will be right in one place and
 *   > stale in the other, and the copy is the one nobody reviews
 *
 * It came true on the patch that said it. These tests are the part that would
 * have caught it: not "is the guard correct" — it was — but "is there more
 * than one, and does the traffic go through this one".
 */

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const PACKAGE_DIR = 'packages/infra/http-fetch/';

const SOURCE_GLOB = new Bun.Glob('{apps,packages,scripts}/**/*.{ts,tsx}');

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of SOURCE_GLOB.scan(REPO_ROOT)) {
    if (rel.includes('node_modules')) continue;
    out.push(rel);
  }
  return out;
}

describe('there is exactly one bounded fetcher', () => {
  test('nothing outside this package implements fetchHtmlBounded', async () => {
    // Two dead copies existed and were deleted. A third would be invisible
    // again: identical, plausible, and never reviewed.
    const offenders: string[] = [];
    for (const rel of await sourceFiles()) {
      if (rel.startsWith(PACKAGE_DIR)) continue;
      const src = await Bun.file(REPO_ROOT + rel).text();
      if (/export\s+(async\s+)?function\s+fetchHtmlBounded\b/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('nor the icon fetcher SC-208 added beside it', async () => {
    // The favicon proxy needed a SECOND bounded fetch — images rather than
    // HTML — and a second bounded fetch is precisely the shape that produced
    // the three copies above. It lives in this package for that reason, and
    // this assertion is what keeps it here.
    const offenders: string[] = [];
    for (const rel of await sourceFiles()) {
      if (rel.startsWith(PACKAGE_DIR)) continue;
      const src = await Bun.file(REPO_ROOT + rel).text();
      if (/export\s+(async\s+)?function\s+fetchImageBounded\b/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('nor the SSRF guard itself', async () => {
    // `assertHostIsPublic` is the security-bearing half. A second definition
    // is the thing that goes stale.
    const offenders: string[] = [];
    for (const rel of await sourceFiles()) {
      if (rel.startsWith(PACKAGE_DIR)) continue;
      const src = await Bun.file(REPO_ROOT + rel).text();
      if (/function\s+assertHostIsPublic\b/.test(src)) offenders.push(rel);
      if (/function\s+followRedirectsSafely\b/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('every caller goes through the guarded one', () => {
  test('fetchHtmlBounded is only ever imported from @scani/http-fetch', async () => {
    // The failure mode this closes: a caller reaching for a relative path into
    // some app-local copy, which is exactly how the dead files stayed alive
    // long enough to be hardened by mistake.
    const offenders: string[] = [];
    let importers = 0;
    for (const rel of await sourceFiles()) {
      if (rel.startsWith(PACKAGE_DIR)) continue;
      const src = await Bun.file(REPO_ROOT + rel).text();
      for (const m of src.matchAll(
        /import\s*\{[^}]*\bfetchHtmlBounded\b[^}]*\}\s*from\s*'([^']+)'/g
      )) {
        importers += 1;
        if (m[1] !== '@scani/http-fetch') offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuous: a scan that finds no importers proves nothing, and this is
    // precisely the assertion that was missing the first time round.
    expect(importers).toBeGreaterThanOrEqual(2);
  });
});

describe('the guarded one does not follow redirects blindly', () => {
  test("the implementation never uses redirect: 'follow'", async () => {
    // The hole itself, pinned in the file that actually serves traffic. The
    // hop walk sets `redirect: 'manual'` and re-validates each hop.
    //
    // Do NOT delete this as duplicative of the hop-walk tests. Those inject
    // their own `fetch`, so the injected function decides redirect behaviour
    // and they structurally cannot observe the real `redirect:` mode —
    // reverting 'manual' to 'follow' leaves every one of them green. Measured:
    // that mutation fails this assertion and nothing else.
    const src = await Bun.file(`${REPO_ROOT}${PACKAGE_DIR}src/fetch-html-bounded.ts`).text();
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain("redirect: 'follow'");
    expect(code).toContain("redirect: 'manual'");
  });

  test('and neither does the icon fetcher — it reuses the same hop walk', async () => {
    // Same reasoning as the assertion above, for the second fetcher. The
    // site-icon tests inject their own `fetch`, so they cannot observe the
    // real redirect mode either: `fetchImageBounded` calling `fetch` directly
    // with `redirect: 'follow'` would leave every one of them green.
    const src = await Bun.file(`${REPO_ROOT}${PACKAGE_DIR}src/site-icon.ts`).text();
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain("redirect: 'follow'");
    expect(code).toContain('followRedirectsSafely(');
    expect(code).toContain('assertHostIsPublic(');
  });

  test('and its host guard is called from the hop walk, not only at the entry point', async () => {
    const src = await Bun.file(`${REPO_ROOT}${PACKAGE_DIR}src/fetch-html-bounded.ts`).text();
    const walk = src.slice(
      src.indexOf('export async function followRedirectsSafely'),
      src.indexOf('export async function fetchHtmlBounded')
    );
    expect(walk).toContain('assertHostIsPublic(next.hostname)');
  });
});
