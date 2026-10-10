import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commentSkipper } from '../../../../../packages/frontend/ui/tests/helpers/source-scan';

/**
 * Every Home card renders through `HomeCard` (SC-1668, UI standard rule 16).
 *
 * The defect this pins: six of nine Home cards had no visible error state, and
 * four returned `null` while loading and on error — which is also what they
 * returned for "you have none", so a failed vaults query read as having no
 * vaults. `HomeCard` is the only place a card may render nothing, and only
 * after its queries answered, so a `return null` in a block is the regression.
 *
 * `HeroBlock` is the page's identity rather than a card, and SC-1669 rebuilds
 * it.
 */
const HOME = resolve(import.meta.dir, '../../src/v3/components/home');
const EXEMPT = new Set(['HeroBlock.tsx']);

const blocks = readdirSync(HOME)
  .filter((name) => name.endsWith('Block.tsx') && !EXEMPT.has(name))
  .sort();

async function code(name: string): Promise<string> {
  const isComment = commentSkipper();
  const text = await Bun.file(join(HOME, name)).text();
  return text
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
}

/** Every way a block can still render nothing on its own: `null`, a bare or
 *  `undefined` return, an empty fragment, or a `HomeCard` behind a condition. */
const RENDERS_NOTHING = [
  /\breturn null\b/,
  /\breturn\s*(undefined)?\s*;/,
  /\breturn\s*<>\s*<\/>/,
  /[?:]\s*\(?\s*<HomeCard\b/,
];

async function violates(name: string): Promise<boolean> {
  const source = await code(name);
  return !source.includes('<HomeCard') || RENDERS_NOTHING.some((pattern) => pattern.test(source));
}

describe('the Home card contract', () => {
  test('the scan reads the real blocks', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    expect(blocks).toContain('VaultsBlock.tsx');
    expect(blocks).toContain('UpcomingBlock.tsx');
  });

  test('every Home block renders through HomeCard and never returns null itself', async () => {
    const offenders: string[] = [];
    for (const name of blocks) {
      if (await violates(name)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
