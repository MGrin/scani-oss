import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Settings > Data quality is read by people, not by whoever wrote the query
 * behind it (SC-1530). The English jargon it used is pinned out here; the
 * other languages are pinned by matching the English rewrite's shape.
 */

const LOCALES = join(import.meta.dir, '../../../src/v3/i18n/locales');
const JARGON = [/token row/i, /coverage row/i, /synthesi[sz]ed/i];

function dataQuality(locale: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(LOCALES, locale), 'utf8'));
  return doc.v3.settings.dataQuality;
}

describe('Data quality copy is in plain words (SC-1530)', () => {
  test('English uses none of the internal terms', () => {
    const text = Object.values(dataQuality('en.json')).join('\n');
    for (const term of JARGON) expect(term.test(text)).toBe(false);
  });

  test('every language rewrote the same three rows', () => {
    const english = dataQuality('en.json');
    for (const file of readdirSync(LOCALES).filter((f) => f.endsWith('.json'))) {
      const rows = dataQuality(file);
      for (const key of ['duplicateRows', 'negativeOpening', 'missingCoverage']) {
        expect(typeof rows[key]).toBe('string');
        if (file !== 'en.json') expect(rows[key]).not.toBe(english[key]);
      }
    }
  });
});
