/**
 * SC-201. A complete translation can be held out of the picker while the
 * interface around it is not ready: Arabic's strings landed before the RTL and
 * font work. Main deploys on merge, so the hold had to be real rather than
 * "nobody will find it".
 *
 * **Arabic is released and the set is empty, which makes this file's job
 * harder rather than easier.** "Everything is offered" is satisfied by a
 * function that returns `true` and reads nothing, so the rule is exercised
 * against a SYNTHETIC set — otherwise the guard for the next held language
 * would rot the moment this one shipped, and nothing would say so.
 *
 * The filter itself is trivial. What can silently break is the wiring: both
 * locale loaders use `import.meta.glob` and cannot be imported here, so the
 * last two tests read their source and require the filter to run before a
 * bundle is registered. Deleting either call turns them red.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadersByCode } from '../../src/i18n/locale-loader';
import { HELD_LANGUAGES, isOfferedLanguage } from '../../src/i18n/offered-languages';

const SRC = join(import.meta.dir, '../../src');
const codesIn = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

describe('offered languages', () => {
  test('nothing is held today, Arabic included', () => {
    // The state, stated. Arabic was the only entry and slice 4 released it.
    expect([...HELD_LANGUAGES]).toEqual([]);
    expect(isOfferedLanguage('ar')).toBe(true);
  });

  test('the rule still holds what it is given — the mechanism, not the state', () => {
    // Against a synthetic set, because the real one is empty. This is the
    // assertion that keeps the guard alive for the next language whose strings
    // arrive before its layout; without it, `isOfferedLanguage` could be
    // reduced to `() => true` and every other test here would still pass.
    const held = new Set(['he']);
    expect(isOfferedLanguage('he', held)).toBe(false);
    expect(isOfferedLanguage('ar', held)).toBe(true);
  });

  test('every locale file is offered, so the hold cannot swallow a shipped language', () => {
    const shipped = codesIn('i18n/locales');
    expect(shipped.length).toBeGreaterThanOrEqual(9);
    expect(shipped.filter((code) => !isOfferedLanguage(code))).toEqual([]);
  });

  // The hold used to be a `continue` in each file's own loop. Locales load on
  // demand now (SC-1498) and both files hand their glob to `loadersByCode`,
  // which is where a held language is dropped — before it is registered,
  // offered or fetched.
  test('loadersByCode drops a held language', () => {
    const load = async () => ({ default: {} });
    const keyed = loadersByCode(
      { './locales/he.json': load, './locales/ar.json': load },
      new Set(['he'])
    );
    expect(Object.keys(keyed)).toEqual(['ar']);
  });

  for (const loader of ['i18n/index.ts', 'v3/i18n/index.ts']) {
    test(`${loader} reaches its lazy locales only through loadersByCode`, () => {
      const source = readFileSync(join(SRC, loader), 'utf8');
      // One call. A second glob would be a second door past the hold.
      expect(source.match(/import\.meta\.glob</g)?.length).toBe(1);
      expect(source).toMatch(/loadersByCode\(\s*import\.meta\.glob/);
    });
  }
});
