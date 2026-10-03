import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/**
 * The engine is a folder, not a workspace, so no package boundary stops an
 * engine file from importing the database or a judgment client. This is the
 * boundary: an engine file may import only other engine files and
 * `@scani/shared`, and may read neither the clock nor randomness nor keep
 * module-level state. Comments are stripped first so a file that explains the
 * rule is not flagged for quoting it.
 *
 * Nor may it call an ES2023-or-later array or collection method. The frontends
 * reach the domain through their router types and type-check it under
 * `lib: ES2022`, so one `toSorted` the engine's own tsconfig accepts turns
 * their type-check red the day a barrel-exported module first imports it.
 */

const ENGINE_DIR = new URL('../../src/engine', import.meta.url).pathname;
const SHARED = '@scani/shared';

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const NONDETERMINISM = /Date\.now\(|new Date\(\s*\)|performance\.now\(|Math\.random\(/g;
const MODULE_LET = /(?<=^|;[ \t]*)(?:export\s+)?(?:let|var)\s/gm;
const MODULE_COLLECTION =
  /(?<=^|;[ \t]*)(?:(?:export\s+)?const\s[^\n]*?=\s*|export\s+default\s+)new\s+(?:Map|Set|WeakMap|WeakSet)\b/gm;

const ES2023_METHODS =
  /\.(?:toSorted|toReversed|toSpliced|findLast|findLastIndex|with)\s*\(|\b(?:Map|Object)\.groupBy\s*\(/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function isAllowedSpecifier(specifier: string, file: string): boolean {
  if (specifier === SHARED) return true;
  if (!specifier.startsWith('.')) return false;
  return resolve(dirname(file), specifier).startsWith(ENGINE_DIR + sep);
}

function scanSource(file: string, source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] as string;
      if (!isAllowedSpecifier(specifier, file)) {
        violations.push(`${file}: imports '${specifier}'`);
      }
    }
  }
  for (const match of code.matchAll(NONDETERMINISM)) {
    violations.push(`${file}: reads the clock or randomness via '${match[0]}'`);
  }
  for (const match of code.matchAll(MODULE_LET)) {
    violations.push(`${file}: module-level mutable binding '${match[0].trim()}'`);
  }
  for (const match of code.matchAll(MODULE_COLLECTION)) {
    violations.push(`${file}: module-level cache '${match[0].trim()}'`);
  }
  for (const match of code.matchAll(ES2023_METHODS)) {
    violations.push(`${file}: calls an ES2023 method '${match[0].replace(/\s+/g, '')}'`);
  }
  return violations;
}

function engineFiles(): string[] {
  if (!existsSync(ENGINE_DIR)) return [];
  return (readdirSync(ENGINE_DIR, { recursive: true }) as string[])
    .filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))
    .map((entry) => resolve(ENGINE_DIR, entry))
    .sort();
}

function scanEngine(): { filesScanned: number; violations: string[] } {
  const files = engineFiles();
  return {
    filesScanned: files.length,
    violations: files.flatMap((file) => scanSource(file, readFileSync(file, 'utf8'))),
  };
}

describe('engine isolation', () => {
  test('the scan reads the engine, so a clean result is not vacuous', () => {
    expect(scanEngine().filesScanned).toBeGreaterThanOrEqual(3);
  });

  test('engine modules import only the engine and @scani/shared', () => {
    const imports = scanEngine().violations.filter((v) => v.includes('imports'));
    expect(imports).toEqual([]);
  });

  test('engine modules never read the clock or randomness', () => {
    const reads = scanEngine().violations.filter((v) => v.includes('clock or randomness'));
    expect(reads).toEqual([]);
  });

  test('engine modules keep no module-level state', () => {
    const state = scanEngine().violations.filter((v) => v.includes('module-level'));
    expect(state).toEqual([]);
  });

  test('engine modules call no ES2023 array or collection method', () => {
    const calls = scanEngine().violations.filter((v) => v.includes('ES2023'));
    expect(calls).toEqual([]);
  });

  test('CONTROL: the scanner flags a database import, a judgment client, a clock read and module-level state', () => {
    const probe = `${ENGINE_DIR}/probe.ts`;
    const source = [
      "import { getDb } from '@scani/db'; import { jev } from '../services/judgment/client'; const t = Date.now();",
      'let counter = 0;',
      'const cache = new Map();',
      'const seen = new Set<string>();',
      'const weak = new WeakMap();',
      'const handlers: Map<string, () => void> = new Map();',
      'export default new Map();',
      'const a = 1; let n = 0;',
      'setup(); const chained = new Map();',
      'export function g(xs: number[]) {',
      '  const a = xs.toSorted(); const b = xs.toReversed(); const c = xs.toSpliced(0, 1);',
      '  const d = xs.findLast((x) => x > 0); const e = xs.findLastIndex((x) => x > 0);',
      '  const f = xs.with(0, 1); const m = Map.groupBy(xs, (x) => x); const o = Object.groupBy (xs, String);',
      '  return [a, b, c, d, e, f, m, o];',
      '}',
    ].join('\n');
    const violations = scanSource(probe, source);
    expect(violations).toHaveLength(19);
    expect(violations.filter((v) => v.includes('ES2023'))).toHaveLength(8);
    expect(violations.filter((v) => v.includes('imports'))).toHaveLength(2);
    expect(violations.filter((v) => v.includes('clock or randomness'))).toHaveLength(1);
    expect(violations.filter((v) => v.includes('mutable binding'))).toHaveLength(2);
    expect(violations.filter((v) => v.includes('module-level cache'))).toHaveLength(6);
  });

  test('CONTROL: the scanner passes engine-relative imports, @scani/shared and local state', () => {
    const probe = `${ENGINE_DIR}/nested/probe.ts`;
    const source = [
      "import { Decimal } from '@scani/shared';",
      "import type { Entry } from '../types';",
      "import { balanceAt } from './balance-at';",
      '// Date.now() and a top-level let are only quoted here',
      'export const makeSeen = () => new Set<string>();',
      'export function f(ts: number) {',
      '  const n = 1;',
      '  let total = new Decimal(0);',
      '  const seen = new Set<string>();',
      '  const sorted = [...[3, 1]].sort((a, b) => a - b);',
      '  const last = sorted.at(-1); const found = sorted.find((x) => x > 1);',
      '  // xs.toSorted() is only quoted here',
      '  return { at: new Date(ts), total, seen, last, found, sortedLength: sorted.length };',
      '}',
    ].join('\n');
    expect(scanSource(probe, source)).toEqual([]);
  });
});
