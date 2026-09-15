/**
 * SC-201. A complete translation can still be held out of the picker while the
 * interface around it is not ready: Arabic's strings land before the RTL and
 * font work. Main deploys on merge, so the hold has to be real rather than
 * "nobody will find it".
 *
 * The filter itself is trivial. What can silently break is the wiring: both
 * locale loaders use `import.meta.glob` and cannot be imported here, so the
 * last two tests read their source and require the filter to run before a
 * bundle is registered. Deleting either call turns them red.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOfferedLanguage } from '../../src/i18n/offered-languages';

const SRC = join(import.meta.dir, '../../src');
const codesIn = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

describe('offered languages', () => {
  test('Arabic is held', () => {
    expect(isOfferedLanguage('ar')).toBe(false);
  });

  test('every other locale file is offered, so the hold cannot swallow a shipped language', () => {
    const shipped = codesIn('i18n/locales').filter((code) => code !== 'ar');
    expect(shipped.length).toBeGreaterThanOrEqual(8);
    expect(shipped.filter((code) => !isOfferedLanguage(code))).toEqual([]);
  });

  for (const loader of ['i18n/index.ts', 'v3/i18n/index.ts']) {
    test(`${loader} skips a held language before it registers anything`, () => {
      const source = readFileSync(join(SRC, loader), 'utf8');
      const loop = source.indexOf('for (const [path, mod] of Object.entries(localeModules))');
      const skip = source.indexOf('if (!isOfferedLanguage(code)) continue;', loop);
      const register = Math.min(
        ...['resources[code]', 'addResourceBundle(code']
          .map((call) => source.indexOf(call, loop))
          .filter((at) => at !== -1)
      );
      expect(loop).toBeGreaterThan(-1);
      expect(Number.isFinite(register)).toBe(true);
      expect(skip).toBeGreaterThan(loop);
      expect(skip).toBeLessThan(register);
    });
  }
});
