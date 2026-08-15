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

  test('App.tsx loads auth, the gate and the install prompt eagerly', async () => {
    const source = await read(APP_ENTRY);
    for (const shell of [
      'AuthProvider',
      'ProtectedRoute',
      'InstallPromptHost',
      'UiVersionGate',
      'UiVersionDocumentScope',
    ]) {
      expect(source).toMatch(new RegExp(`^import[^;]*\\b${shell}\\b`, 'm'));
    }
  });

  test('the sign-in screen is eager — a split shell would defer the first thing a visitor sees', async () => {
    expect(await read(APP_ENTRY)).toMatch(/^import\s*\{\s*Auth\s*\}/m);
  });
});

describe('both UI generations are deferred', () => {
  test('App.tsx reaches v2 and v3 only through lazyRoute', async () => {
    const source = await read(APP_ENTRY);
    // A static import of either one puts it back in the entry chunk and
    // silently undoes the split — the build still succeeds and nothing fails
    // but the byte count.
    expect(source).not.toMatch(/^import\s*\{[^}]*\bV2App\b[^}]*\}\s*from/m);
    expect(source).not.toMatch(/^import\s*\{[^}]*\bV3App\b[^}]*\}\s*from/m);
    expect(source).toContain('lazyRoute');
    expect(source).toMatch(/import\(['"]@\/v2\/V2App['"]\)/);
    expect(source).toMatch(/import\(['"]@\/v3\/V3App['"]\)/);
  });

  test('v2 is still reachable — deferred, never removed', async () => {
    // v2 is permanent chrome in both directions (see v3/lib/ui-version.ts), so
    // its route has to stay registered.
    expect(await read(APP_ENTRY)).toMatch(/path=\{`\$\{V2_BASE\}\/\*`\}/);
  });
});

describe('every dynamic import handles its own failure', () => {
  /**
   * `warm-ui-version.ts` is the one exemption and it earns it: it is a
   * best-effort prefetch that catches, and whose result nothing awaits. The
   * real load still goes through `lazyRoute`.
   */
  const EXEMPT = ['lib/warm-ui-version.ts'];

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
    const source = await read(join(SRC, 'lib/warm-ui-version.ts'));
    expect(source).toMatch(/\.catch\(/);
  });

  test('the warm-up never picks between two imports in one expression', async () => {
    // Vite computes `__vitePreload`'s dependency list statically, so a
    // conditional whose branches are both `import()` collapses to ONE list —
    // v3's — and warming v2 fetches the v3 chunk as well. Writing it as
    // `if (…) return import(a); return import(b);` does not help: esbuild folds
    // that back into a ternary before Vite sees it. Only separate function
    // bodies survive, which is why `LOADERS` is a map.
    //
    // Nothing else catches this. The chunk hash is identical, type-check is
    // happy, and it is visible only in a browser's request list.
    // Comments stripped first — the file explains the trap using the very
    // syntax it forbids, and a guard that trips on its own documentation is a
    // guard nobody keeps.
    const code = stripComments(await read(join(SRC, 'lib/warm-ui-version.ts')));
    expect(code).not.toMatch(/[?:]\s*import\(/);
    expect(code).toMatch(/v2:\s*\(\)\s*=>\s*import\(/);
    expect(code).toMatch(/v3:\s*\(\)\s*=>\s*import\(/);
  });
});
