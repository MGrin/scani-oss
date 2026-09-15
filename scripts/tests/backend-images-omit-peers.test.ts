import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SC-804. The api and data-provider deps stages downloaded Next.js: `better-auth`
 * declares `next` as an OPTIONAL peer, and bun installs an optional peer
 * whenever `bun.lock` already resolves it — which it does, for the frontends.
 * SC-794 removed it from the worker by cutting an edge; these two use
 * `better-auth` for real, so there is no edge to cut.
 *
 * `--omit=peer` is the flag that works, and it drops REQUIRED peers as well.
 * So the property this file holds is the pair: the flag is on both install
 * lines, AND every required peer of each image's dependency graph is reachable
 * through ordinary dependencies. The second half is what fails first in
 * practice — a new dependency with a required peer builds green and loses the
 * peer in the image — and the control below proves it can go red.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

const IMAGES = [
  { dockerfile: 'apps/backend/api/Dockerfile', workspace: '@scani/backend' },
  { dockerfile: 'apps/backend/data-provider/Dockerfile', workspace: '@scani/data-provider' },
] as const;

interface LockWorkspace {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageMeta {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
}

interface Lock {
  workspaces: Record<string, LockWorkspace>;
  packages: Record<string, unknown[]>;
}

/** `bun.lock` is JSONC with trailing commas and no comments in practice. */
function readLock(): Lock {
  const text = readFileSync(join(ROOT, 'bun.lock'), 'utf8');
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as Lock;
}

function metaOf(lock: Lock, name: string): PackageMeta | null {
  const entry = lock.packages[name];
  if (!entry) return null;
  const meta = entry[2];
  return meta && typeof meta === 'object' ? (meta as PackageMeta) : {};
}

function depNames(from: LockWorkspace | PackageMeta): string[] {
  return [...Object.keys(from.dependencies ?? {}), ...Object.keys(from.optionalDependencies ?? {})];
}

/**
 * Walk the ordinary dependency graph of one workspace — what survives
 * `--omit=peer` — and report the peers it asks for, split by whether they are
 * optional.
 */
function peerReport(lock: Lock, workspace: string) {
  const byName = new Map(
    Object.values(lock.workspaces)
      .filter((w): w is LockWorkspace & { name: string } => typeof w.name === 'string')
      .map((w) => [w.name, w])
  );
  const root = byName.get(workspace);
  if (!root) throw new Error(`NOTHING WAS WALKED: no workspace named ${workspace} in bun.lock`);

  const reachable = new Set<string>();
  const requiredPeers = new Map<string, Set<string>>();
  const optionalPeers = new Set<string>();
  const stack = depNames(root);
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const ws = byName.get(name);
    if (ws) {
      stack.push(...depNames(ws));
      continue;
    }
    const meta = metaOf(lock, name);
    if (!meta) continue;
    stack.push(...depNames(meta));
    const optional = new Set(meta.optionalPeers ?? []);
    for (const peer of Object.keys(meta.peerDependencies ?? {})) {
      if (optional.has(peer)) optionalPeers.add(peer);
      else requiredPeers.set(peer, (requiredPeers.get(peer) ?? new Set()).add(name));
    }
  }

  const undeclared = [...requiredPeers.keys()].filter((peer) => !reachable.has(peer)).sort();
  return { reachable, undeclared, optionalPeers };
}

describe('SC-804 — backend images install no optional peers and lose no required ones', () => {
  for (const image of IMAGES) {
    test(`${image.dockerfile} installs its own graph with --omit=peer`, () => {
      const text = readFileSync(join(ROOT, image.dockerfile), 'utf8');
      const install = text.split('\n').filter((line) => /^RUN bun install\b/.test(line));
      expect(install).toHaveLength(1);
      expect(install[0]).toContain(`--filter ${image.workspace}`);
      expect(install[0]).toContain('--omit=peer');
      expect(install[0]).toContain('--frozen-lockfile');
    });

    test(`every required peer of ${image.workspace} is an ordinary dependency`, () => {
      const report = peerReport(readLock(), image.workspace);
      // Control that the walk read a real graph: elysia is the server both run.
      expect(report.reachable.has('elysia')).toBe(true);
      expect(report.undeclared).toEqual([]);
    });
  }

  test('the check goes red when a required peer is left undeclared', () => {
    const lock = readLock();
    const api = Object.values(lock.workspaces).find((w) => w.name === '@scani/backend');
    if (!api?.dependencies) throw new Error('no @scani/backend dependencies in bun.lock');
    const { 'file-type': _dropped, ...rest } = api.dependencies;
    api.dependencies = rest;
    expect(peerReport(lock, '@scani/backend').undeclared).toContain('file-type');
  });

  test('the reason for the flag still exists: next is an optional peer in the api graph', () => {
    // If this goes red, better-auth stopped offering `next` as a peer, and the
    // flag may no longer be needed — re-measure before deleting it.
    expect(peerReport(readLock(), '@scani/backend').optionalPeers.has('next')).toBe(true);
    expect(readLock().packages.next).toBeDefined();
  });
});
