import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taxYearPdfLabelsSchema } from '@scani/shared';
import {
  recentTaxYears,
  taxYearLabel,
  taxYearPdfLabels,
} from '../../../src/v3/lib/tax-year-statement';

const LOCALES = join(import.meta.dir, '../../../src/v3/i18n/locales');

/** A `t` over one locale file, so every language is checked without switching i18next. */
function translatorFor(file: string) {
  const tree = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'));
  return (key: string) => {
    const value = key.split('.').reduce((node, part) => node?.[part], tree);
    if (typeof value !== 'string') throw new Error(`${file}: missing ${key}`);
    return value;
  };
}

const locales = readdirSync(LOCALES).filter((f) => f.endsWith('.json'));

describe('taxYearPdfLabels (SC-90)', () => {
  test('there is more than one locale to check', () => {
    expect(locales.length).toBeGreaterThan(1);
  });

  for (const file of locales) {
    test(`${file}: the labels satisfy the server's contract, caveat included`, () => {
      const labels = taxYearPdfLabels(translatorFor(file));
      expect(taxYearPdfLabelsSchema.safeParse(labels).success).toBe(true);
      expect(labels.caveat.length).toBeGreaterThan(0);
    });

    test(`${file}: every detail label fits the PDF's 18-character label column`, () => {
      const { details } = taxYearPdfLabels(translatorFor(file));
      const long = Object.entries(details).filter(([, v]) => [...v].length > 18);
      expect(long).toEqual([]);
    });
  }

  test('English carries the ruled caveat sentence', () => {
    expect(taxYearPdfLabels(translatorFor('en.json')).caveat).toBe(
      'Figures can change if past data or the method changes; keep the PDF you filed.'
    );
  });
});

describe('taxYearLabel', () => {
  test('a calendar tax year is one year; any other start spans two', () => {
    expect(taxYearLabel(2025, 'jan-1')).toBe('2025');
    expect(taxYearLabel(2025, 'apr-6')).toBe('2025–26');
    expect(taxYearLabel(2099, 'jul-1')).toBe('2099–00');
  });
});

describe('recentTaxYears', () => {
  test('six years, newest first, from the current calendar year', () => {
    expect(recentTaxYears(new Date('2026-09-19T00:00:00Z'))).toEqual([
      2026, 2025, 2024, 2023, 2022, 2021,
    ]);
  });
});
