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

// Tracked files, listed once: the glob this replaces walked every
// `node_modules` tree before filtering it out, once per test, and read 16.8s on
// a loaded CI box against a 1.6s median (SC-1593).
let listed: Promise<string[]> | undefined;
function sourceFiles(): Promise<string[]> {
  listed ??= (async () => {
    const proc = Bun.spawnSync(
      [
        'git',
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'apps',
        'packages',
        'scripts',
      ],
      {
        cwd: REPO_ROOT,
      }
    );
    if (!proc.success) throw new Error('git ls-files failed, so no file was scanned');
    const files = proc.stdout
      .toString()
      .split('\0')
      .filter((rel) => /\.tsx?$/.test(rel) && !rel.includes('node_modules'));
    if (files.length < 100) throw new Error(`git ls-files listed only ${files.length} files`);
    return files;
  })();
  return listed;
}

let texts: Promise<Map<string, string>> | undefined;
function sourceText(rel: string): Promise<string> {
  texts ??= sourceFiles().then(
    async (files) =>
      new Map(
        await Promise.all(
          files.map(async (file) => [file, await Bun.file(REPO_ROOT + file).text()] as const)
        )
      )
  );
  return texts.then((all) => all.get(rel) ?? '');
}

describe('there is exactly one bounded fetcher', () => {
  test('nothing outside this package implements fetchHtmlBounded', async () => {
    // Two dead copies existed and were deleted. A third would be invisible
    // again: identical, plausible, and never reviewed.
    const offenders: string[] = [];
    for (const rel of await sourceFiles()) {
      if (rel.startsWith(PACKAGE_DIR)) continue;
      const src = await sourceText(rel);
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
      const src = await sourceText(rel);
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
      const src = await sourceText(rel);
      if (/function\s+assertHostIsPublic\b/.test(src)) offenders.push(rel);
      if (/function\s+followRedirectsSafely\b/.test(src)) offenders.push(rel);
      // `withBudget` joined this list in SC-208. It is a BOUND, and a bound
      // that exists twice drifts exactly like a guard that exists twice: the
      // icon path and the HTML path would end up with different ideas of how
      // long a stuck DNS lookup may take, and only one of them would be
      // reviewed when the number next changes.
      if (/function\s+withBudget\b/.test(src)) offenders.push(rel);
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
      const src = await sourceText(rel);
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
  });

  test('and its host guard is called from the hop walk, not only at the entry point', async () => {
    const src = await Bun.file(`${REPO_ROOT}${PACKAGE_DIR}src/fetch-html-bounded.ts`).text();
    const walk = src.slice(
      src.indexOf('export async function followRedirectsSafely'),
      src.indexOf('export async function fetchHtmlBounded')
    );
    // Every hop, including the first, and the request is pinned to the answer
    // that was judged rather than re-resolved by `fetch` (SC-1284).
    expect(walk).toContain('assertHostIsPublic(current.hostname, resolve)');
    expect(walk).toContain('fetchImpl(...pinnedRequest(current, address, init))');
  });
});
