import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * SC-1211. A module that calls `import.meta.glob` throws the moment it is
 * LOADED under `bun test`, where that Vite build-time API is `undefined`. A
 * test file that reaches one through its static imports therefore dies before
 * registering a single test — so it prints no `(fail)` line, and its tests
 * disappear from the count rather than going red. SC-1207 lost 19 tests from
 * `capture.test.tsx` and `capture-forms.test.tsx` that way, because
 * `auth-client` imported `@/i18n`.
 *
 * This walks every test file's STATIC import graph with Bun's own resolver —
 * the one the crash goes through, so `@/` and workspace specifiers resolve
 * exactly as they do at load — and fails naming the file and the chain.
 * Dynamic `import()` is not an edge: it does not run at load, and a lazy route
 * reaching a Vite-only module is how the app is meant to reach it.
 *
 * A Vite-only module that no test reaches is fine, and the control below
 * asserts two such modules exist, so a detector that sees nothing cannot pass.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const VITE_ONLY = /\bimport\.meta\.glob(?:Eager)?\b/;
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs)$/;

interface Tree {
  /** The source of a repo-relative file, or null when there is none. */
  read(file: string): string | null;
  /** The repo-relative file a specifier names from `from`, or null when it leaves the repo. */
  resolve(specifier: string, from: string): string | null;
}

const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

// `define` rewrites the expression in CODE and never inside a string or a
// comment, which a text match cannot tell apart — this file names the API in
// strings of its own and read as Vite-only until it did this. The marker is
// joined at run time so the literal is not in this file either.
const MARKER = ['__sc1211', 'vite', 'glob__'].join('_');
const DETECTORS = {
  ts: new Bun.Transpiler({
    loader: 'ts',
    define: { 'import.meta.glob': MARKER, 'import.meta.globEager': MARKER },
  }),
  tsx: new Bun.Transpiler({
    loader: 'tsx',
    define: { 'import.meta.glob': MARKER, 'import.meta.globEager': MARKER },
  }),
};

function transpilerFor(file: string) {
  return file.endsWith('x') ? TRANSPILERS.tsx : TRANSPILERS.ts;
}

/** Whether `file` calls a Vite-only API in CODE — a comment or a string naming one does not count. */
function isViteOnly(file: string, source: string): boolean {
  if (!VITE_ONLY.test(source)) return false;
  const detector = file.endsWith('x') ? DETECTORS.tsx : DETECTORS.ts;
  return detector.transformSync(source).includes(MARKER);
}

function staticImports(file: string, source: string): string[] {
  return transpilerFor(file)
    .scanImports(source.replace(/^#!.*/, ''))
    .filter((entry) => entry.kind !== 'dynamic-import')
    .map((entry) => entry.path);
}

/** For each root that reaches a Vite-only module at load, the chain that does it. */
function viteOnlyChains(roots: readonly string[], tree: Tree): Map<string, string[]> {
  // file -> the chain from it to a Vite-only module, or null for none.
  const memo = new Map<string, string[] | null>();

  const walk = (file: string): string[] | null => {
    const known = memo.get(file);
    if (known !== undefined) return known;
    // Provisional null breaks import cycles; a cycle adds no new module to reach.
    memo.set(file, null);
    const source = tree.read(file);
    if (source === null || !SOURCE.test(file)) return null;
    if (isViteOnly(file, source)) {
      memo.set(file, [file]);
      return [file];
    }
    for (const specifier of staticImports(file, source)) {
      const target = tree.resolve(specifier, file);
      if (target === null) continue;
      const chain = walk(target);
      if (chain) {
        const found = [file, ...chain];
        memo.set(file, found);
        return found;
      }
    }
    return null;
  };

  const out = new Map<string, string[]>();
  for (const root of roots) {
    const chain = walk(root);
    if (chain) out.set(root, chain);
  }
  return out;
}

function describeChains(chains: Map<string, string[]>): string {
  const lines = [...chains].map(([root, chain]) => `  ${root}\n    ${chain.join('\n    -> ')}`);
  return [
    `${chains.size} test file(s) reach a module calling import.meta.glob, which is undefined under bun test.`,
    'Such a file crashes while LOADING and registers no tests, so it prints no (fail) line —',
    'its tests vanish from the count instead of going red (SC-1211, SC-844).',
    'Import what you need without passing through the Vite-only module (see src/lib/auth-client.ts).',
    ...lines,
  ].join('\n');
}

function realTree(): Tree {
  return {
    read(file) {
      try {
        return readFileSync(join(REPO, file), 'utf8');
      } catch {
        return null;
      }
    },
    resolve(specifier, from) {
      let absolute: string;
      try {
        absolute = Bun.resolveSync(specifier, join(REPO, dirname(from)));
      } catch {
        // Unresolvable here is unresolvable at load too, and that crash is not
        // this check's subject: bun names the missing specifier itself.
        return null;
      }
      const rel = relative(REPO, absolute);
      if (rel.startsWith('..') || rel.includes('node_modules/')) return null;
      return rel;
    },
  };
}

/** Every file `bun run test` loads: its preloads, and each test file under the roots it names. */
function testEntryPoints(): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts: { test: string };
  };
  const tokens = manifest.scripts.test.trim().split(/\s+/);
  const preloads = tokens.filter((_, i) => tokens[i - 1] === '--preload');
  const verb = tokens.findIndex((t, i) => t === 'test' && tokens[i - 1] === 'bun');
  const args = tokens.slice(verb + 1);
  const roots = args.filter((t, i) => !t.startsWith('-') && !args[i - 1]?.startsWith('-'));
  const ls = Bun.spawnSync(['git', 'ls-files', '-z', '--', ...roots], { cwd: REPO });
  if (ls.exitCode !== 0) throw new Error('git ls-files failed; no test file was enumerated');
  const tests = ls.stdout
    .toString()
    .split('\0')
    .filter((file) => /\.test\.(?:ts|tsx|js|jsx)$/.test(file));
  return [...preloads.map((p) => p.replace(/^\.\//, '')), ...tests];
}

function fakeTree(files: Record<string, string>): Tree {
  return {
    read: (file) => files[file] ?? null,
    resolve: (specifier, from) => {
      if (!specifier.startsWith('.')) return null;
      const file = join(dirname(from), specifier);
      return [file, `${file}.ts`, `${file}.tsx`].find((f) => f in files) ?? null;
    },
  };
}

describe('the check itself (SC-1211)', () => {
  const GLOB = "const m = import.meta.glob('./locales/*.json', { eager: true });\nexport { m };\n";

  test('reds on a test that reaches a Vite-only module, naming the chain', () => {
    const chains = viteOnlyChains(
      ['t/a.test.ts'],
      fakeTree({
        't/a.test.ts': "import { x } from '../src/auth';\n",
        'src/auth.ts': "import './i18n';\nexport const x = 1;\n",
        'src/i18n.ts': GLOB,
      })
    );
    expect(chains.get('t/a.test.ts')).toEqual(['t/a.test.ts', 'src/auth.ts', 'src/i18n.ts']);
    expect(describeChains(chains)).toContain('registers no tests, so it prints no (fail) line');
  });

  test('passes once the import is gone — the same tree minus one edge', () => {
    const chains = viteOnlyChains(
      ['t/a.test.ts'],
      fakeTree({
        't/a.test.ts': "import { x } from '../src/auth';\n",
        'src/auth.ts': 'export const x = 1;\n',
        'src/i18n.ts': GLOB,
      })
    );
    expect(chains.size).toBe(0);
  });

  test('a string naming the API is not a use of it — this file holds several', () => {
    const chains = viteOnlyChains(
      ['t/a.test.ts'],
      fakeTree({ 't/a.test.ts': 'export const s = "import.meta.glob";\n' })
    );
    expect(chains.size).toBe(0);
  });

  test('a dynamic import, a type-only import and a comment are not edges', () => {
    const chains = viteOnlyChains(
      ['t/a.test.ts'],
      fakeTree({
        't/a.test.ts': [
          "import type { M } from '../src/i18n';",
          '// import.meta.glob is Vite-only',
          "export const lazy = () => import('../src/i18n');",
        ].join('\n'),
        'src/i18n.ts': GLOB,
      })
    );
    expect(chains.size).toBe(0);
  });
});

describe('no test file reaches import.meta.glob at load (SC-1211)', () => {
  const tree = realTree();
  const entries = testEntryPoints();

  test('the control: the scan sees the Vite-bound modules that legitimately exist', () => {
    // Both are Vite-bound by design, reached through `main.tsx` and the lazy v3
    // chunk. If the detector stopped seeing them, the test below would pass
    // over anything.
    for (const file of [
      'apps/frontend/app/src/i18n/index.ts',
      'apps/frontend/app/src/v3/i18n/index.ts',
    ]) {
      expect(viteOnlyChains([file], tree).get(file)).toEqual([file]);
    }
    expect(entries.length).toBeGreaterThan(500);
  });

  test('every test file and preload loads without passing through one', () => {
    const chains = viteOnlyChains(entries, tree);
    if (chains.size > 0) throw new Error(describeChains(chains));
    expect(chains.size).toBe(0);
  });
});
