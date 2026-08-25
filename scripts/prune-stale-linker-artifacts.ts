import type { Dirent } from 'node:fs';
import { readdir, readlink, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Removes per-workspace `node_modules` left behind by bun's isolated linker.
 *
 * Isolated installs fill each workspace's `node_modules` with symlinks into the
 * root `node_modules/.bun` store. `bunfig.toml` pins the hoisted linker, which
 * neither creates those directories nor cleans them up — so a checkout that
 * installed before the switch keeps a farm of symlinks pointing at a `.bun`
 * store that no longer exists, and the next `bun run dev` dies on
 * `ENOENT reading .../node_modules/reflect-metadata`.
 *
 * Only directories that still hold a `.bun` symlink are removed, which makes
 * this a one-time migration and a no-op on every later install.
 */

const ROOT = resolve(import.meta.dir, '..');
const STORE_MARKER = 'node_modules/.bun/';
const MAX_DEPTH = 2;

async function holdsStoreSymlink(dir: string, depth = 0): Promise<boolean> {
  if (depth > MAX_DEPTH) return false;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // The store is already gone, so the link cannot be resolved — match on
      // the raw target text instead.
      if ((await readlink(path)).includes(STORE_MARKER)) return true;
    } else if (entry.isDirectory() && (await holdsStoreSymlink(path, depth + 1))) {
      return true;
    }
  }

  return false;
}

async function workspaceDirs(): Promise<string[]> {
  const { workspaces = [] } = (await Bun.file(join(ROOT, 'package.json')).json()) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];

  for (const pattern of workspaces) {
    if (!pattern.endsWith('/*')) {
      dirs.push(join(ROOT, pattern));
      continue;
    }
    const parent = join(ROOT, pattern.slice(0, -2));
    try {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(parent, entry.name));
      }
    } catch {
      // A workspace glob matching no directory is not an error.
    }
  }

  return dirs;
}

const pruned: string[] = [];

for (const dir of await workspaceDirs()) {
  const modules = join(dir, 'node_modules');
  try {
    if (!(await stat(modules)).isDirectory()) continue;
  } catch {
    continue;
  }
  if (!(await holdsStoreSymlink(modules))) continue;

  await rm(modules, { recursive: true, force: true });
  pruned.push(modules.slice(ROOT.length + 1));
}

if (pruned.length > 0) {
  console.log(`Pruned ${pruned.length} stale isolated-linker node_modules:`);
  for (const path of pruned) console.log(`  - ${path}`);
}
