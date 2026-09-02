import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BALANCE_GAP_REVIEW_PATH, REVIEW_PATH, TRANSFER_REVIEW_PATH } from '@scani/shared';

/**
 * A review destination is written once, in `@scani/shared` (SC-861).
 *
 * This package mints `ReviewItem.href` and v3's router resolves it, so a
 * review path is the one kind of path that crosses a package boundary. When
 * it was spelled on both sides — `TRANSFER_REVIEW_PATH` in `routes.ts` and a
 * bare `'/review/transfers'` here — nothing tied the pair together, and
 * nothing could: moving the route left the feed row pointing at v3's terminal
 * catch-all, with no throw, no failing test and a row that still looked like a
 * row.
 *
 * **That is why the check is a source scan rather than an assertion on the
 * output.** A test that reads the emitted `href` passes just as happily on a
 * literal that happens to match today, which is the state this defect starts
 * in — the two spellings agree right up until one of them moves. The thing
 * worth pinning is that there is no second spelling to move.
 *
 * The needles are the constants' own values, so a rename carries the guard
 * with it rather than leaving it checking a path nothing uses.
 */

const DOMAIN_SRC = resolve(import.meta.dir, '../../src');
const FEED_SERVICE = join(DOMAIN_SRC, 'services/ReviewFeedService.ts');

/** Source with comments removed: a path named in prose is not a spelling of
 *  it, and this repo has twice been told the opposite by a grep that counted
 *  one. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * The same source with its import statements dropped, so "the file reaches
 * this constant" means it is *used* rather than merely imported. Kept separate
 * from `code`, because the scan below must still see an `export const` that
 * hardcodes a path.
 *
 * Whole statements, not lines: a line filter leaves the identifiers of a
 * multi-line `import { … }` behind, and the control then passes on a file that
 * imports the constant and never uses it — which was measured, on the first
 * draft of this file.
 */
function body(file: string): string {
  return code(file).replace(/\bimport\b[\s\S]*?from\s*['"][^'"]*['"];?/g, '');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const SOURCES = sourceFiles(DOMAIN_SRC).map((file) => ({ file, code: code(file) }));

/** Every way of writing the path as a literal: `'/review/transfers'`,
 *  `"/review/transfers"`, and the template form a `${...}` suffix would use. */
function literalSpellings(path: string): string[] {
  return [`'${path}`, `"${path}`, `\`${path}`];
}

describe('review paths are spelled once, in @scani/shared', () => {
  test('there is a package to scan at all', () => {
    // A scan that reads nothing reports clean, which is the shape this guard
    // exists to refuse: it would pass on a moved directory or a broken walk.
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.some(({ file }) => file === FEED_SERVICE)).toBe(true);
  });

  test('the feed reaches the shared constants rather than restating them', () => {
    // The positive control. Without it, deleting the import and every use
    // would satisfy the scan below by leaving nothing to find.
    const used = body(FEED_SERVICE);
    expect(used).toContain('TRANSFER_REVIEW_PATH');
    expect(used).toContain('BALANCE_GAP_REVIEW_PATH');
  });

  test.each([
    ['REVIEW_PATH', REVIEW_PATH],
    ['TRANSFER_REVIEW_PATH', TRANSFER_REVIEW_PATH],
    ['BALANCE_GAP_REVIEW_PATH', BALANCE_GAP_REVIEW_PATH],
  ])('%s is not written as a literal anywhere in @scani/domain', (name, path) => {
    const spellings = literalSpellings(path);
    const offenders = SOURCES.filter(({ code: body }) =>
      spellings.some((spelling) => body.includes(spelling))
    ).map(({ file }) => file.replace(`${DOMAIN_SRC}/`, 'src/'));

    expect(
      offenders,
      `${path} is written as a string literal in ${offenders.join(', ')}. It is owned by ` +
        `${name} in @scani/shared, which v3's route table also reads — a second spelling here ` +
        'is one nothing follows on a rename, and the feed row it produces resolves to v3’s ' +
        'catch-all without failing anything. Import the constant instead.'
    ).toEqual([]);
  });
});
