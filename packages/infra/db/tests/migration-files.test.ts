import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  formatStamp,
  HIGHEST_LEGACY_INDEX,
  newMigrationTag,
  parseStamp,
  parseTag,
  readMigrationFiles,
  slugify,
} from '../src/migration-files';

/**
 * SC-335. Four migrations collided in one day — 0043, 0044, 0047 and 0048 —
 * and every one of the four threads had checked `origin/main` first, because
 * the brief told it to and because that is the only check there was. The
 * number was correct when it was read and stale by the time the PR opened.
 *
 * These tests hold the property that replaced the check: a migration's name
 * is not a claim about what else exists, so nothing can invalidate it.
 */
const MIGRATIONS = path.join(import.meta.dir, '..', 'src', 'migrations');

describe('migration filenames', () => {
  const files = readMigrationFiles(MIGRATIONS);

  test('the folder is non-empty, so none of this passes vacuously', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  test('every file has a parseable tag', () => {
    // readMigrationFiles throws on a bad one, so reaching here is the
    // assertion. Restated explicitly because a silent skip is the failure
    // mode this whole area is about.
    expect(files.filter((f) => f.parsed === null)).toEqual([]);
  });

  test('the four-digit space is closed at 0050', () => {
    // The contended integer. A new file in this space means someone had to
    // pick "the next one", which is precisely what cannot be known on a
    // branch — so it is a build failure, not a review note.
    const overruns = files
      .filter((f) => f.parsed.kind === 'legacy')
      .filter((f) => f.parsed.kind === 'legacy' && f.parsed.index > HIGHEST_LEGACY_INDEX)
      .map((f) => f.tag);
    expect(overruns).toEqual([]);
  });

  test('every legacy migration keeps the name it was applied under', () => {
    // 0000-0050 are applied in production. Renaming one makes the runner
    // refuse — deliberately — so freeze the set here where the failure is
    // one line of output instead of a blocked deploy.
    const legacy = files.filter((f) => f.parsed.kind === 'legacy').map((f) => f.tag);
    expect(legacy[0]).toBe('0000_clean_start');
    expect(legacy).toContain('0049_sc339_sc352_drop_restated_solana_rows');
    // 0050 merged from another branch while this one was in review — the last
    // migration the contended integer will ever produce.
    expect(legacy).toContain('0050_sc357_rekey_solana_to_net_per_token');
  });

  test('timestamp prefixes are unique', () => {
    const stamps = files.flatMap((f) => (f.parsed.kind === 'stamped' ? [f.parsed.stamp] : []));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test('every legacy migration sorts before every stamped one', () => {
    // Not an accident worth relying on silently: a 14-digit stamp beats a
    // 4-digit index on the first character for any year from 1000 to 9999.
    const kinds = files.map((f) => f.parsed.kind);
    const firstStamped = kinds.indexOf('stamped');
    const lastLegacy = kinds.lastIndexOf('legacy');
    if (firstStamped !== -1 && lastLegacy !== -1) expect(lastLegacy).toBeLessThan(firstStamped);
  });

  test('apply order is the sorted order of the filenames', () => {
    expect(files.map((f) => f.tag)).toEqual([...files.map((f) => f.tag)].sort());
  });
});

describe('parseStamp', () => {
  test('accepts a real instant', () => {
    expect(parseStamp('20260817143012')?.toISOString()).toBe('2026-08-17T14:30:12.000Z');
  });

  test('rejects a 14-digit value that is not a date', () => {
    // `Date.UTC` rolls February 31st into March 3rd rather than failing, so a
    // typo would otherwise become a valid-looking migration whose name says
    // one instant and whose ordering says another.
    expect(parseStamp('20260231000000')).toBeNull();
    expect(parseStamp('20260817250000')).toBeNull();
  });

  test('rejects anything that is not exactly 14 digits', () => {
    expect(parseStamp('2026081714301')).toBeNull();
    expect(parseStamp('202608171430123')).toBeNull();
    expect(parseStamp('0049')).toBeNull();
  });

  test('round-trips formatStamp', () => {
    const at = new Date('2026-12-31T23:59:59.000Z');
    expect(parseStamp(formatStamp(at))?.getTime()).toBe(at.getTime());
  });
});

describe('parseTag', () => {
  test('reads a legacy index', () => {
    expect(parseTag('0049_sc339_sc352_drop_restated_solana_rows')).toEqual({
      kind: 'legacy',
      index: 49,
    });
  });

  test('reads a stamped tag', () => {
    const parsed = parseTag('20260817143012_holding_label');
    expect(parsed?.kind).toBe('stamped');
    expect(parsed?.kind === 'stamped' && parsed.stamp).toBe('20260817143012');
  });

  test('rejects uppercase, dashes and spaces', () => {
    expect(parseTag('20260817143012_HoldingLabel')).toBeNull();
    expect(parseTag('20260817143012_holding-label')).toBeNull();
    expect(parseTag('20260817143012 holding')).toBeNull();
    expect(parseTag('holding_label')).toBeNull();
  });
});

describe('newMigrationTag', () => {
  const at = new Date('2026-08-17T14:30:12.000Z');

  test('stamps the slug', () => {
    expect(newMigrationTag('holding label', at)).toBe('20260817143012_holding_label');
  });

  test('two calls a second apart cannot produce the same name', () => {
    const a = newMigrationTag('same slug', at);
    const b = newMigrationTag('same slug', new Date(at.getTime() + 1000));
    expect(a).not.toBe(b);
  });

  test('refuses a slug with nothing usable in it', () => {
    expect(() => newMigrationTag('   ---   ', at)).toThrow(/needs a slug/);
  });
});

describe('slugify', () => {
  test('collapses to lower snake case', () => {
    expect(slugify('SC-335: numbers cannot collide!')).toBe('sc_335_numbers_cannot_collide');
  });
});

describe('readMigrationFiles', () => {
  test('names the reason when a four-digit index is reintroduced', async () => {
    const dir = await makeFolder({ '0051_next_one.sql': 'select 1' });
    expect(() => readMigrationFiles(dir)).toThrow(/SC-335/);
  });

  test('rejects a name that is neither scheme', async () => {
    const dir = await makeFolder({ 'add_a_column.sql': 'select 1' });
    expect(() => readMigrationFiles(dir)).toThrow(/not a migration name/);
  });

  test('rejects two files sharing a timestamp', async () => {
    const dir = await makeFolder({
      '20260817143012_one.sql': 'select 1',
      '20260817143012_two.sql': 'select 2',
    });
    expect(() => readMigrationFiles(dir)).toThrow(/share a timestamp prefix/);
  });

  test('ignores non-sql files', async () => {
    const dir = await makeFolder({
      '20260817143012_one.sql': 'select 1',
      'README.md': 'not a migration',
    });
    expect(readMigrationFiles(dir).map((f) => f.tag)).toEqual(['20260817143012_one']);
  });
});

async function makeFolder(files: Record<string, string>): Promise<string> {
  const dir = path.join(process.env.TMPDIR ?? '/tmp', `scani-mig-${crypto.randomUUID()}`);
  for (const [name, body] of Object.entries(files)) {
    await Bun.write(path.join(dir, name), body);
  }
  return dir;
}
