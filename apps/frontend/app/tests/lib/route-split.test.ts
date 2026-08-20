import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The conditions the route split was allowed under, checked rather than
 * remembered.
 *
 * SC-132 lifted the repo's top-level-import ban for frontend route splitting,
 * and attached three non-negotiable conditions to it. Two of them are properties
 * of the source and can be enforced here; the third (measure before and after)
 * belongs to `apps/e2e/scripts/measure-bundle-tti.ts`.
 *
 * 1. **Never split the shell.** Auth, the theme and token layer, the install
 *    prompt and the error boundary load eagerly. An interface that assembles
 *    itself in pieces is worse than one that appears late.
 * 2. **A failed chunk fetch must be handled.** Every `import()` goes through
 *    `importChunk` — which retries, then fails with a sentence — or is a
 *    deliberate best-effort warm-up that swallows its own rejection. An
 *    unhandled one is a white screen, which in the installed PWA has no URL bar
 *    to escape from (SC-62, SC-73).
 *
 * A static check, because the failure is invisible to type-check and to every
 * component test: both look identical whether the chunk arrives or not.
 */

const SRC = resolve(import.meta.dir, '../../src');
const APP_ENTRY = join(SRC, 'App.tsx');
const MAIN_ENTRY = join(SRC, 'main.tsx');

/** `import(` that is a real dynamic import, not `import.meta` or a comment. */
const DYNAMIC_IMPORT = /(?<![.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

async function read(file: string): Promise<string> {
  return await Bun.file(file).text();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the shell is never split', () => {
  test('main.tsx loads the providers and the error boundary eagerly', async () => {
    const source = await read(MAIN_ENTRY);
    for (const shell of [
      'ErrorBoundary',
      'ThemeProvider',
      'TRPCProvider',
      'Toaster',
      'UpdateBanner',
    ]) {
      expect(source).toMatch(new RegExp(`^import[^;]*\\b${shell}\\b`, 'm'));
    }
  });

  test('App.tsx loads auth, the legacy redirects and the install prompt eagerly', async () => {
    const source = await read(APP_ENTRY);
    for (const shell of [
      'AuthProvider',
      'ProtectedRoute',
      'InstallPromptHost',
      'LegacyV2PathRedirect',
      'LegacyV3PathRedirect',
    ]) {
      expect(source).toMatch(new RegExp(`^import[^;]*\\b${shell}\\b`, 'm'));
    }
  });

  test('the sign-in screen is eager — a split shell would defer the first thing a visitor sees', async () => {
    expect(await read(APP_ENTRY)).toMatch(/^import\s*\{\s*Auth\s*\}/m);
  });
});

describe('the interface is deferred', () => {
  test('App.tsx reaches it only through lazyRoute', async () => {
    const source = await read(APP_ENTRY);
    // A static import puts it back in the entry chunk and silently undoes the
    // split — the build still succeeds and nothing fails but the byte count.
    expect(source).not.toMatch(/^import\s*\{[^}]*\bV3App\b[^}]*\}\s*from/m);
    expect(source).toContain('lazyRoute');
    expect(source).toMatch(/import\(['"]@\/v3\/V3App['"]\)/);
  });

  /**
   * The classic interface was the second half of this split until SC-423
   * deleted it. Its namespace outlives it as a redirect: `/v2` is in
   * bookmarks, in shared links, and in the installed PWA's start URL for every
   * reader who had chosen it, and a prefix nobody strips is a path that falls
   * to the catch-all with the prefix still on it.
   */
  test('the retired prefixes are still routed, as redirects', async () => {
    const source = await read(APP_ENTRY);
    expect(source).toMatch(/path="\/v2\/\*"/);
    expect(source).toMatch(/path="\/v3\/\*"/);
  });
});

describe('every dynamic import handles its own failure', () => {
  /**
   * `warm-interface.ts` is the one exemption and it earns it: it is a
   * best-effort prefetch that catches, and whose result nothing awaits. The
   * real load still goes through `lazyRoute`.
   */
  const EXEMPT = ['lib/warm-interface.ts'];

  test('no import() is left to reject into the render path', async () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (EXEMPT.includes(rel)) continue;
      const source = await read(file);
      for (const match of source.matchAll(DYNAMIC_IMPORT)) {
        // The import must sit inside an `importChunk(...)` or `lazyRoute(...)`
        // call. Both put retries and a readable failure around it; checking the
        // 200 characters before the call is enough to tell, because the wrapper
        // is always the immediately enclosing expression.
        const before = source.slice(Math.max(0, match.index - 200), match.index);
        if (!/\b(importChunk|lazyRoute)\s*\(/.test(before)) {
          offenders.push(`${rel}: import('${match[1]}')`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('the exemption really does swallow its own rejection', async () => {
    const source = await read(join(SRC, 'lib/warm-interface.ts'));
    expect(source).toMatch(/\.catch\(/);
  });

  /**
   * Vite computes `__vitePreload`'s dependency list statically, so a
   * conditional whose branches are both `import()` collapses to ONE list and
   * warming either branch fetches both chunks. Writing it as
   * `if (…) return import(a); return import(b);` does not help: esbuild folds
   * that back into a ternary before Vite sees it.
   *
   * There is one chunk to warm since SC-423, so the trap is not live — but it
   * is a property of Vite rather than of the tree that is gone, and it comes
   * back the moment a second `import()` is put behind a condition here.
   * Nothing else catches it: the chunk hash is identical, type-check is happy,
   * and it is visible only in a browser's request list.
   *
   * Comments stripped first — the file explains the trap using the very syntax
   * it forbids, and a guard that trips on its own documentation is a guard
   * nobody keeps.
   */
  test('the warm-up never picks between two imports in one expression', async () => {
    const code = stripComments(await read(join(SRC, 'lib/warm-interface.ts')));
    expect(code).not.toMatch(/[?:]\s*import\(/);
    expect(code.match(/(?<![.\w])import\s*\(/g) ?? []).toHaveLength(1);
  });
});
