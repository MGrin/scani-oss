/**
 * SC-634, generalised from SC-630. A dependency added in one workspace moved
 * the version that wins the single root `node_modules` slot for a workspace
 * the change never touched, and the docs build died on a clean install while
 * every developer checkout stayed green.
 *
 * The half that made it invisible is checked here: **nobody's `node_modules`
 * was the lockfile's.** The developer tree still held the pre-change hoist
 * winner, so the build that would have failed passed.
 *
 * WHAT IS MISSING IS A SIGNAL, NOT A REPAIR, and SC-634 was filed saying the
 * opposite — that `bun install --frozen-lockfile` printed `no changes` over a
 * wrong version. Measured 2026-09-04 on bun 1.3.14, it REPAIRS: a root package
 * edited to `0.0.1-mutated` came back `5.1.0`, rc=0, `1 package installed`.
 * The reading that became the ticket's premise was superseded by its own
 * thread an hour later — a clean install from that lockfile reproduced that
 * tree exactly, so `2.0.3` was lockfile-consistent and `no changes` was
 * correct.
 *
 * The gap is that nothing RUNS an install before the gate, and bun ships no
 * detector: `--frozen-lockfile --dry-run` prints a byte-identical 2658-line
 * listing over a clean tree and a corrupted one and exits 0 for both, so there
 * is no cheaper reading of this than the one below. `deps:lint` aligns
 * declared ranges, `deps:unused` reads files and manifests, and the gate never
 * looked at the tree at all.
 *
 * So this reads `node_modules`, which is the artefact every other check in
 * this repo declines to read, and it fails on a stale tree — which the narrow
 * per-package version pin that shipped for SC-630 does not: on a checkout
 * installed before that commit it reads the good version and passes, exactly
 * like the docs build it was standing in for.
 *
 * WHAT THIS DOES NOT DO, and it was measured rather than assumed. It does not
 * catch the flip itself on a lockfile-faithful tree. At SC-630's commit the
 * lockfile gave every Astro package a NESTED `unist-util-visit@5`, plain node
 * resolution from `node_modules/astro` reached it, and the clean install
 * matched the lockfile exactly — so a satisfiability check over the installed
 * tree is GREEN on the tree that broke the deploy and RED on the tree that
 * works (the accepted `@conventional-commits/parser` mismatch the override
 * leaves behind). The failure is the bundler's: Astro emits its prerender
 * chunk under `apps/frontend/docs/dist/`, the bare `unist-util-visit` import
 * is left external, and it re-resolves from the WORKSPACE, where hoisting
 * offers only the root copy. Nothing short of a build sees that. What this
 * buys is that the build, whenever one runs, is a statement about the
 * lockfile's tree rather than about whatever happens to be on disk.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

interface Drift {
  readonly name: string;
  readonly lock: string;
  readonly disk: string;
}

interface Report {
  readonly compared: number;
  readonly drift: readonly Drift[];
  readonly missing: readonly string[];
  readonly skippedForPlatform: number;
  readonly skippedForProtocol: number;
  /** In the lockfile, absent, and nothing installed asks for it. */
  readonly skippedUnasked: number;
}

/**
 * `bun.lock` is JSONC — trailing commas, no comments in practice. Stripping a
 * comma only where whitespace and a closer follow it cannot reach inside a
 * package name, a semver range or an integrity hash, which is every string
 * this file holds. A parse failure is never resolved toward "clean": the
 * caller throws, because a checker that cannot read its input has not looked.
 */
function parseLock(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [v as string]);

/** A root-level entry: `foo`, or `@scope/foo`. Anything deeper is nested. */
const isRootEntry = (key: string): boolean =>
  key.startsWith('@') ? key.split('/').length === 2 : !key.includes('/');

export async function checkInstalledTree(root: string): Promise<Report> {
  const lockText = await Bun.file(join(root, 'bun.lock')).text();
  const lock = parseLock(lockText) as {
    packages?: Record<string, unknown[]>;
    workspaces?: Record<string, Record<string, Record<string, string>>>;
  };
  const packages = lock.packages;
  if (!packages || Object.keys(packages).length === 0) {
    throw new Error(`NOTHING WAS COMPARED: no packages in ${join(root, 'bun.lock')}`);
  }

  /**
   * A name is only EXPECTED at the root slot if something that is itself
   * installed asks for it. Five entries here are wasm shims required solely by
   * `*-wasm32-wasi` bindings that this platform never installs, so demanding
   * them would make the check permanently red on every machine. Expectation
   * flows only from installed packages, so one pass is enough: an installed
   * package's own dependencies are installed, or they are the finding.
   */
  const expected = new Set<string>();
  for (const meta of Object.values(lock.workspaces ?? {})) {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const dep of Object.keys(meta[field] ?? {})) expected.add(dep);
    }
  }
  for (const [name, entry] of Object.entries(packages)) {
    const deps = (entry[2] as { dependencies?: Record<string, string> } | undefined)?.dependencies;
    if (!deps) continue;
    const physical = name
      .split('/')
      .reduce<string[]>((acc, seg) => {
        const last = acc[acc.length - 1];
        if (last?.startsWith('@') && !last.includes('/')) acc[acc.length - 1] = `${last}/${seg}`;
        else acc.push(seg);
        return acc;
      }, [])
      .join('/node_modules/');
    if (!(await Bun.file(join(root, 'node_modules', physical, 'package.json')).exists())) continue;
    for (const dep of Object.keys(deps)) expected.add(dep);
  }

  const drift: Drift[] = [];
  const missing: string[] = [];
  let compared = 0;
  let skippedForPlatform = 0;
  let skippedForProtocol = 0;
  let skippedUnasked = 0;

  for (const [name, entry] of Object.entries(packages)) {
    if (!isRootEntry(name)) continue;

    const spec = String(entry[0] ?? '');
    const at = spec.lastIndexOf('@');
    const locked = at > 0 ? spec.slice(at + 1) : '';
    // `workspace:`, `link:`, `file:` and anything else that is not a resolved
    // registry version. A workspace's own `package.json` version is its own
    // business and says nothing about hoisting.
    if (!/^\d/.test(locked)) {
      skippedForProtocol++;
      continue;
    }

    const meta = (entry[2] ?? {}) as { os?: unknown; cpu?: unknown };
    const forThisPlatform =
      (!meta.os || asList(meta.os).includes(process.platform)) &&
      (!meta.cpu || asList(meta.cpu).includes(process.arch));

    const manifest = Bun.file(join(root, 'node_modules', name, 'package.json'));
    if (!(await manifest.exists())) {
      // `os: none` / a foreign platform is why 132 of these are absent here.
      if (!forThisPlatform) skippedForPlatform++;
      else if (expected.has(name)) missing.push(`${name}@${locked}`);
      else skippedUnasked++;
      continue;
    }

    compared++;
    const onDisk = String(((await manifest.json()) as { version?: string }).version ?? '');
    if (onDisk !== locked) drift.push({ name, lock: locked, disk: onDisk });
  }

  return { compared, drift, missing, skippedForPlatform, skippedForProtocol, skippedUnasked };
}

/**
 * A fixture tree: a `bun.lock` holding exactly `entries`, and a
 * `node_modules` holding exactly `installed`. Small enough to read, and every
 * arm below differs from the next by one line of it.
 */
function fixture(
  entries: Record<string, unknown[]>,
  installed: Record<string, string>
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sc634-'));
  // The root workspace asks for every entry, so `missing` is exercised rather
  // than skipped as unasked. The real tree's five unasked entries are the
  // reason that distinction exists; here it must not be the reason an arm
  // passes.
  const asks = Object.fromEntries(
    Object.keys(entries)
      .filter((k) => (k.startsWith('@') ? k.split('/').length === 2 : !k.includes('/')))
      .map((k) => [k, '*'])
  );
  writeFileSync(
    join(dir, 'bun.lock'),
    // Trailing commas on purpose: the real file has them, and a parser that
    // only handles strict JSON would pass every arm here and fail in the repo.
    `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "dependencies": ${JSON.stringify(asks)} } },\n  "packages": {\n${Object.entries(
      entries
    )
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join('\n')}\n  },\n}\n`
  );
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version })
    );
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const registry = (spec: string, meta: Record<string, unknown> = {}) => [spec, '', meta, 'sha512-x'];

describe('the checker can come back red', () => {
  test('a version on disk that is not the locked one is drift, by name', async () => {
    const f = fixture(
      { 'unist-util-visit': registry('unist-util-visit@5.1.0') },
      { 'unist-util-visit': '2.0.3' }
    );
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.compared).toBe(1);
      expect(r.drift).toEqual([{ name: 'unist-util-visit', lock: '5.1.0', disk: '2.0.3' }]);
      expect(r.missing).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test('a locked package absent from the tree is reported, not ignored', async () => {
    const f = fixture({ leftpad: registry('leftpad@1.0.0') }, {});
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.missing).toEqual(['leftpad@1.0.0']);
      expect(r.compared).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});

describe('the checker can come back green, and for the right reasons', () => {
  test('a matching version is not drift', async () => {
    const f = fixture(
      { 'unist-util-visit': registry('unist-util-visit@5.1.0') },
      { 'unist-util-visit': '5.1.0' }
    );
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.drift).toEqual([]);
      expect(r.compared).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  // Without this the check is red on every machine: 132 entries in this repo's
  // lockfile are binaries for platforms this one is not, and `bun install`
  // correctly writes none of them.
  test('a package for another platform is absent without being missing', async () => {
    const other = process.platform === 'linux' ? 'darwin' : 'linux';
    const f = fixture(
      {
        '@esbuild/foreign': registry('@esbuild/foreign@1.0.0', { os: other, cpu: process.arch }),
        '@esbuild/wasm': registry('@esbuild/wasm@1.0.0', { os: 'none', cpu: 'none' }),
      },
      {}
    );
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.missing).toEqual([]);
      expect(r.skippedForPlatform).toBe(2);
      expect(r.skippedUnasked).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  // The same shape one step over: a package for THIS platform, absent, must
  // still be missing — or the arm above would be an excuse rather than a rule.
  test('and one for this platform, absent, still is', async () => {
    const f = fixture(
      {
        '@esbuild/native': registry('@esbuild/native@1.0.0', {
          os: process.platform,
          cpu: process.arch,
        }),
      },
      {}
    );
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.missing).toEqual(['@esbuild/native@1.0.0']);
      expect(r.skippedForPlatform).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  test('a workspace entry carries no registry version and is not compared', async () => {
    const f = fixture({ '@scani/db': ['workspace:packages/infra/db'] }, {});
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.skippedForProtocol).toBe(1);
      expect(r.missing).toEqual([]);
      expect(r.compared).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  // The five `@emnapi/*`-shaped entries in this repo. Absent, for this
  // platform on paper, and required only by a `wasm32-wasi` binding that is
  // itself never installed — so demanding them would make the check red on
  // every machine forever.
  test('an entry nothing installed asks for is not missing', async () => {
    const f = fixture({ 'wasm-shim': registry('wasm-shim@1.0.0') }, {});
    try {
      const bare = f.dir;
      // Rewrite the lockfile so the root workspace asks for nothing.
      writeFileSync(
        join(bare, 'bun.lock'),
        '{ "lockfileVersion": 1, "workspaces": { "": {} }, "packages": { "wasm-shim": ["wasm-shim@1.0.0", "", {}, "sha512-x"], }, }'
      );
      const r = await checkInstalledTree(bare);
      expect(r.missing).toEqual([]);
      expect(r.skippedUnasked).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  test('a nested entry is not a root slot and is not compared', async () => {
    const f = fixture(
      {
        'unist-util-visit': registry('unist-util-visit@5.1.0'),
        'astro/unist-util-visit': registry('unist-util-visit@2.0.3'),
      },
      { 'unist-util-visit': '5.1.0' }
    );
    try {
      const r = await checkInstalledTree(f.dir);
      expect(r.compared).toBe(1);
      expect(r.drift).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});

describe('blindness is not a pass', () => {
  test('an unreadable lockfile throws rather than reporting a clean tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc634-blind-'));
    try {
      await expect(checkInstalledTree(dir)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lockfile with no packages is refused by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc634-empty-'));
    writeFileSync(join(dir, 'bun.lock'), '{ "lockfileVersion": 1, "packages": {} }');
    try {
      await expect(checkInstalledTree(dir)).rejects.toThrow('NOTHING WAS COMPARED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('this checkout', () => {
  // The floor is what separates "compared everything, found nothing" from a
  // run that read one package and said the tree was fine. 1210 were compared
  // when this was written; the floor is deliberately far below that, so an
  // ordinary dependency removal does not turn a correctness check into a
  // bookkeeping one.
  test('installed tree matches bun.lock', async () => {
    const r = await checkInstalledTree(ROOT);

    expect(r.compared).toBeGreaterThan(800);

    const message = [
      ...r.drift.map((d) => `  ${d.name}: bun.lock says ${d.lock}, node_modules has ${d.disk}`),
      ...r.missing.map((m) => `  ${m}: in bun.lock, absent from node_modules`),
      '',
      '  Run `bun install`. Until you do, every check in this repo — the gate,',
      '  a frontend build, a type-check — is a statement about a dependency tree',
      '  that is not the one this branch pins (SC-634).',
    ].join('\n');

    expect(r.drift.length + r.missing.length, `\n${message}`).toBe(0);
  });
});
