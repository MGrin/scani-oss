import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A key that resolves is not a key that renders.
 *
 * SC-202 established the ceiling of `scan-v3-strings.ts --progress`: it measures
 * whether strings reached the catalogue, not whether the catalogue reaches the
 * screen. A lookup table of translation keys that is read into JSX **without**
 * `t()` puts the key itself on a user's screen — and every existing guard
 * passes, because the key genuinely exists and the file genuinely imports
 * `useTranslation`.
 *
 * Two live instances, one week apart in the same conversion:
 *   - `REVIEW_STATE_LABEL_KEYS[...]` in ExtractionRecord.tsx (caught by a test
 *     asserting the rendered word)
 *   - `RETRY_UNAVAILABLE_KEYS[...]` in JobDetailHeader.tsx (shipped to
 *     production in de5ae6d5 and found by grepping for the class afterwards)
 *
 * This is the cheap structural half of that class: a `*KEY(S)`-named table
 * indexed inside JSX braces must be wrapped. It cannot catch a key resolved
 * into a variable and rendered later — that still needs a test asserting the
 * rendered English, which is why those tests stay.
 */
const ROOTS = [
  join(import.meta.dir, '..', '..', 'src', 'v3'),
  join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'frontend', 'ui', 'src', 'v3'),
];

function tsxFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(tsxFiles(full));
    } else if (entry.endsWith('.tsx') && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/** `{SOMETHING_KEYS[expr]}` in JSX, with no `t(` anywhere in the braces. */
const RAW_KEY_RENDER = /\{\s*([A-Za-z_]*(?:KEY|KEYS|Key|Keys)[A-Za-z_]*\s*\[[^\]]+\][^}]{0,60})\}/g;

describe('a translation-key table is never rendered unwrapped', () => {
  const files = ROOTS.flatMap((r) => {
    try {
      return tsxFiles(r);
    } catch {
      return [];
    }
  });

  test('there are files to check, so this cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('no *KEY(S) lookup reaches JSX without t()', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(RAW_KEY_RENDER)) {
        const fragment = m[1] ?? '';
        if (fragment.includes('t(')) continue;
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(
          `${file.split('/src/')[1] ?? file}:${line} — ${fragment.trim().slice(0, 60)}`
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
