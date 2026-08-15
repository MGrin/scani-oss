import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Where v3's source lives, now that it lives in two places.
 *
 * V3-28 promoted the reusable half of v3 — `PageLayout`, `DataRow`, `Numeric`,
 * `PeekSheet`, `ConfirmAction`, the charts, the whole `V3DataView` subtree and
 * their libs — into `@scani/ui`, because `apps/frontend/cloud` renders the same
 * surfaces and a second copy of any of them is a second place for the token
 * rules to be got wrong.
 *
 * The three text scans that guard those rules (`token-hygiene`, `layout`,
 * `safe-area`) are the reason this file exists rather than each of them
 * hard-coding `../../src/v3`. A component that moves out of the app must not
 * move out of the scans with it: the promoted files are *more* exposed, not
 * less, because two apps now render them. So the scans read both roots, and a
 * file is named by its path below whichever root holds it — the two trees have
 * the same shape and no overlapping paths, so a relative name is still unique.
 */
const APP_V3 = resolve(import.meta.dir, '../../../src/v3');
const UI_V3 = resolve(import.meta.dir, '../../../../../../packages/frontend/ui/src/v3');

export const V3_ROOTS = [APP_V3, UI_V3] as const;

export interface V3Source {
  /** Absolute path. */
  path: string;
  /** Path below its root — `components/PeekSheet.tsx`. */
  name: string;
}

function walk(dir: string, root: string, extensions: readonly string[], out: V3Source[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, extensions, out);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push({ path: full, name: relative(root, full) });
    }
  }
}

/** Every v3 source across both roots, in a stable order. */
export function v3Sources(extensions: readonly string[] = ['.tsx']): V3Source[] {
  const out: V3Source[] = [];
  for (const root of V3_ROOTS) walk(root, root, extensions, out);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads one v3 source by its root-relative name, from whichever root has it. */
export async function readV3Source(name: string): Promise<string> {
  for (const root of V3_ROOTS) {
    const file = Bun.file(join(root, name));
    if (await file.exists()) return file.text();
  }
  throw new Error(`no v3 source named ${name} under either root`);
}
