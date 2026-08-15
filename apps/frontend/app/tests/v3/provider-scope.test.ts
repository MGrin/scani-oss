import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The provider-scope guard.
 *
 * v3 is a second app rendered from the same bundle, and it reaches into v2 for
 * hooks and helpers on purpose — rewriting `useDataView` to port one screen
 * would be worse than borrowing it. But a borrowed hook drags its whole
 * dependency chain with it, and if anything in that chain calls a context hook
 * whose provider is mounted *inside* `V2App`, the context is simply absent in
 * the v3 tree.
 *
 * That has now shipped twice. `BaseCurrencyProvider` failed quietly (SC-36):
 * `useBaseCurrency()` read a USD placeholder and rendered believable money in
 * the wrong currency. `RealtimeProvider` failed loudly (SC-39):
 * `useHoldingRefresh` → `useJobStatus` → `useRealtimeConnection()`, which
 * throws, so `/holdings` rendered the error boundary instead of the page.
 * Both type-checked. Both passed their component tests, because a component
 * test never mounts the route under the real provider tree.
 *
 * So the invariant is checked statically: walk the v3 import graph, and for
 * every app context hook something in it calls, require the provider to be
 * mounted where v3 can see it — above the split in `App.tsx`, or inside
 * `V3App.tsx` itself.
 *
 * Scope note: this covers `src/contexts`, which is where both failures lived.
 * Providers that come from `@scani/ui` (`ThemeProvider`, `TRPCProvider`) are
 * mounted in `main.tsx`, above everything, and cannot be split-scoped.
 */

const SRC = resolve(import.meta.dir, '../../src');
const CONTEXTS_DIR = join(SRC, 'contexts');
const V3_ENTRY = join(SRC, 'v3/V3App.tsx');
const APP_ENTRY = join(SRC, 'App.tsx');

/** `export function useX(...) { … }` up to the first column-0 closing brace. */
const HOOK_BLOCK = /export function (use\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
/** Anything ending in `Provider` named inside that body — the throw message
 *  names the provider in both of the phrasings the two contexts use. */
const PROVIDER_NAME = /\b(\w+Provider)\b/;

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const EXTENSIONS = ['.tsx', '.ts', '/index.tsx', '/index.ts'];

async function readText(file: string): Promise<string> {
  return await Bun.file(file).text();
}

/** Resolve a bare specifier to a file inside `src`, or null if it leaves it. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null; // node_modules or another workspace — not ours to walk.

  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` without leaving `src`. */
async function importClosure(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const code = await readText(file);
    seen.set(file, code);
    for (const match of code.matchAll(IMPORT)) {
      const next = resolveSpecifier(match[1] as string, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** hook name → the provider its own error message names. */
async function contextHooks(): Promise<Map<string, string>> {
  const hooks = new Map<string, string>();
  for (const file of readdirSync(CONTEXTS_DIR).filter((f) => f.endsWith('.tsx'))) {
    const code = await readText(join(CONTEXTS_DIR, file));
    for (const match of code.matchAll(HOOK_BLOCK)) {
      const provider = PROVIDER_NAME.exec(match[2] as string);
      if (provider) hooks.set(match[1] as string, provider[1] as string);
    }
  }
  return hooks;
}

const hooks = await contextHooks();
const v3Closure = await importClosure(V3_ENTRY);
const appSource = await readText(APP_ENTRY);
const v3Sources = [...v3Closure.entries()]
  .filter(([file]) => file.startsWith(join(SRC, 'v3/')))
  .map(([, code]) => code)
  .join('\n');

describe('providers the v3 tree depends on', () => {
  test('every app context exposes a hook that names its provider', () => {
    // If this list stops matching `src/contexts`, the regex above has gone
    // stale and the guard below is silently checking nothing.
    expect([...hooks.entries()].sort()).toEqual([
      ['useAuth', 'AuthProvider'],
      ['useBaseCurrency', 'BaseCurrencyProvider'],
      ['useRealtimeConnection', 'RealtimeProvider'],
    ]);
  });

  test('the v3 import graph reaches into v2, which is why this test exists', () => {
    const borrowed = [...v3Closure.keys()].filter((f) => f.startsWith(join(SRC, 'v2/')));
    expect(borrowed.length).toBeGreaterThan(0);
  });

  for (const [hook, provider] of hooks) {
    test(`${hook} is only reachable from v3 if ${provider} is mounted above the split`, () => {
      const callers = [...v3Closure.entries()]
        .filter(([, code]) => new RegExp(`\\b${hook}\\s*\\(`).test(code))
        .map(([file]) => relative(SRC, file))
        .sort();
      if (callers.length === 0) return;

      // Mounted above the v2/v3 split, or by v3 itself. Anywhere else — most
      // plausibly `V2App.tsx` — means these callers throw or read a default.
      const mounted = appSource.includes(`<${provider}`) || v3Sources.includes(`<${provider}`);
      // Listing the callers rather than asserting the boolean: a bare `false`
      // says the guard tripped, this says which import chain to go and cut.
      const unprotected = mounted ? [] : callers;
      expect(unprotected).toEqual([]);
    });
  }

  test('each hoisted provider is mounted exactly once in the whole tree', async () => {
    // Hoisting a provider is only safe if the old mount went away. Two
    // `RealtimeProvider`s would be two WebSockets, two ping loops and two
    // invalidation storms per broadcast — and nothing on screen would say so.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tsx')) files.push(full);
      }
    };
    walk(SRC);

    const counts = new Map<string, string[]>();
    for (const file of files) {
      // `src/contexts` is skipped wholesale: a provider renders
      // `<XContext.Provider>`, never `<XProvider>`, so nothing there is a
      // mount — but `useBaseCurrency`'s error message quotes the tag, and a
      // sentence in a string is not a second WebSocket.
      if (file.startsWith(`${CONTEXTS_DIR}/`)) continue;
      const code = await readText(file);
      for (const provider of new Set(hooks.values())) {
        const mounts = code.match(new RegExp(`<${provider}[\\s>]`, 'g'));
        if (mounts) {
          counts.set(provider, [...(counts.get(provider) ?? []), relative(SRC, file)]);
        }
      }
    }

    expect(Object.fromEntries([...counts].map(([k, v]) => [k, v.sort()]))).toEqual({
      AuthProvider: ['App.tsx'],
      BaseCurrencyProvider: ['App.tsx'],
      RealtimeProvider: ['App.tsx'],
    });
  });
});
