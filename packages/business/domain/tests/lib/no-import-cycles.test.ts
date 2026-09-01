/**
 * `@scani/domain` has no import cycle nobody has looked at (SC-902).
 *
 * ## What went wrong, and why nothing caught it
 *
 * `lib/transfer-matching` imported a `const` out of `ManualBalanceEditService`,
 * which reaches `HoldingTransactionRepository`, which imports
 * `lib/transfer-matching` back. A cycle of `const` declarations does not fail
 * where it is written — it fails wherever the runtime happens to ENTER it, so
 * the same tree is fine from one entry point and dead from another:
 *
 *     bun run test                       10239 pass  ← the gate
 *     bun test tests/services/ReviewFeedService.test.ts
 *       ReferenceError: Cannot access 'MANUAL_EDIT_FLOW_SOURCE'
 *       before initialization
 *
 * And it announced itself as `Ran 1 test across 1 file` rather than as a file
 * that could not be loaded — a non-result rendering as a settled one.
 *
 * So the thing worth asserting is the CYCLE, statically, rather than any one
 * entry point's luck. A test that ran the failing file would have passed the
 * moment the load order shifted.
 *
 * ## The allowlist is an assertion, not a mute
 *
 * The two entries below are class-reference cycles: each side imports the
 * other's CLASS and reads it only inside a method or a `Container.get()` class
 * field, both of which run at construction time rather than at module
 * evaluation. They cannot reach a temporal dead zone. Adding a third entry
 * means claiming the same thing about it, and the claim is checkable — a
 * module-level `const`, array or `new` that reads across the cycle is exactly
 * what this test exists to refuse.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../src');

/** Cycles that are known, looked at, and cannot fault at module evaluation. */
const ALLOWED_CYCLES: readonly (readonly string[])[] = [
  ['services/TransferReviewService.ts', 'use-cases/UpdateHoldingUseCase.ts'],
  [
    'services/index.ts',
    'services/ReviewFeedService.ts',
    'services/TransferReviewService.ts',
    'use-cases/UpdateHoldingUseCase.ts',
  ],
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Relative specifiers this module pulls in AT RUNTIME.
 *
 * A whole-line `import type` is erased by the compiler and cannot hold a
 * cycle open, so it is skipped. An inline `type Foo` specifier inside an
 * otherwise-value import is NOT skipped: the module edge survives.
 *
 * The clause may not contain a quote. That is what stops the match starting
 * at one `import` and running to a LATER statement's `from` — which is not a
 * hypothetical: the first draft of this file read `import type { X } from
 * './PortfolioValuationService'` as a value edge, because it had begun
 * matching four imports earlier, and reported a cycle that does not exist.
 */
export function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(^|\n)[ \t]*(import|export)\b([^'"]*?)from\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[3] ?? '';
    if (/^\s+type\s/.test(clause)) continue;
    specifiers.push(match[4] as string);
  }
  for (const match of source.matchAll(/(^|\n)[ \t]*import\s+['"](\.[^'"]+)['"]/g)) {
    specifiers.push(match[2] as string);
  }
  return specifiers;
}

function resolveSpecifier(fromFile: string, specifier: string, known: Set<string>): string | null {
  const base = normalize(join(dirname(fromFile), specifier));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function buildGraph(): Map<string, string[]> {
  const files = listSourceFiles(SRC);
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps = new Set<string>();
    for (const specifier of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, specifier, known);
      if (target) deps.add(target);
    }
    graph.set(file, [...deps].sort());
  }
  return graph;
}

/** Every cycle in `graph`, each as its sorted member set joined by ` + `. */
export function findCycles(graph: Map<string, string[]>): Set<string> {
  const found = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];

  const walk = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        const members = stack.slice(stack.indexOf(next)).sort();
        found.add(members.join(' + '));
      } else if (!state.has(next)) {
        walk(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) walk(node);
  }
  return found;
}

describe('@scani/domain import cycles (SC-902)', () => {
  // must-be-FOUND. Without it, a detector that reported nothing would be
  // indistinguishable from a healthy package — which is the failure this whole
  // file is about.
  it('the detector finds a cycle when there is one', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
      ['d', ['a']],
    ]);
    expect([...findCycles(graph)]).toEqual(['a + b + c']);
  });

  it('the detector reports nothing on an acyclic graph', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect([...findCycles(graph)]).toEqual([]);
  });

  // The edge reader is the half that decides what a cycle IS. Both arms:
  // a type-only import that must NOT become an edge, and a value import in
  // the same file that must.
  it('reads value edges and erases type-only ones', () => {
    const source = [
      "import { withDeadline } from '@scani/deadline';",
      "import { Service } from 'typedi';",
      "import type { PortfolioValueResult } from './PortfolioValuationService';",
      "import { PortfolioValueCache } from './PortfolioValueCache';",
      "import { type Lot, matchLots } from './lot-matching';",
      "export * from './barrel';",
      "import './side-effect';",
    ].join('\n');

    expect(valueImportSpecifiers(source).sort()).toEqual([
      './PortfolioValueCache',
      './barrel',
      './lot-matching',
      './side-effect',
    ]);
  });

  it('has only the cycles that have been looked at', () => {
    const graph = buildGraph();
    expect(graph.size).toBeGreaterThan(100);

    const allowed = new Set(ALLOWED_CYCLES.map((members) => [...members].sort().join(' + ')));
    const actual = new Set(
      [...findCycles(graph)].map((key) =>
        key
          .split(' + ')
          .map((file) => relative(SRC, file))
          .sort()
          .join(' + ')
      )
    );

    expect([...actual].filter((key) => !allowed.has(key))).toEqual([]);
    expect([...allowed].filter((key) => !actual.has(key))).toEqual([]);
  });
});
