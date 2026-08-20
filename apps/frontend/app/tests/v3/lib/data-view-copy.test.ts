import '../../i18n-preload';

import { describe, expect, it } from 'bun:test';
import {
  countLabel,
  describeFilteredEmpty,
  filterOptionLabel,
  resolveActiveFilters,
  type UiTranslationKey,
  type V3FilterDef,
} from '@scani/ui/v3/lib/data-view';
import shellEn from '../../../src/i18n/locales/en.json';
import v3En from '../../../src/v3/i18n/locales/en.json';

/**
 * The list-surface copy a reader sees, asserted against the app's REAL bundle
 * (SC-318).
 *
 * These four helpers used to take the caller's `t`. Every caller was inside
 * `@scani/ui` and passed the kit's own instance, so nothing shipped broken —
 * but the parameter let an app-side caller hand over `useTranslation()`'s
 * instance, which holds the app's 286 `ui.dataView.*` keys and **none** of the
 * kit's 133. Measured on the code this test replaces, with the app's `t`:
 *
 *     describeFilteredEmpty(t, 'ui.dataView.noun.holdings', 'sol', [])
 *       -> title: "ui.dataView.empty.noMatchSearch"
 *
 * The noun inside the sentence resolved and the sentence around it did not,
 * which is the failure that is hardest to notice in review and impossible to
 * miss on a screen.
 *
 * The test lives app-side deliberately: the fact worth pinning is that the
 * app's nouns and filter labels — forwarded into the kit's instance by
 * `addUiLocale` at boot, mirrored here by the preload — still resolve now that
 * nothing is threaded through. A kit-side fixture could not tell you that.
 */

/** A `ui.`-prefixed identifier that reached the screen instead of its copy. */
const RAW_UI_KEY = /\bui\.[a-z][a-zA-Z]*\.[a-zA-Z.]+/;

const en = { ...shellEn, ...v3En } as {
  ui: { dataView: { noun: Record<string, string> } };
};

/**
 * Every noun the app declares, discovered from the bundle rather than listed,
 * so a surface added later is covered without anyone remembering to add it.
 * i18next's plural suffixes are stripped back to the base key a `nounKey`
 * actually carries.
 */
const NOUN_KEYS = [
  ...new Set(
    Object.keys(en.ui.dataView.noun).map(
      (key) => `ui.dataView.noun.${key.replace(/_(one|other|counted_one|counted_other)$/, '')}`
    )
  ),
].sort();

describe('data-view copy resolves against the kit instance', () => {
  it('covers every noun the app declares', () => {
    expect(NOUN_KEYS.length).toBeGreaterThan(10);
  });

  it('countLabel renders a counted noun, not a key', () => {
    for (const nounKey of NOUN_KEYS) {
      for (const count of [0, 1, 2, 12]) {
        const label = countLabel(nounKey, count);
        expect(label).not.toMatch(RAW_UI_KEY);
        expect(label).toContain(String(count));
      }
    }
  });

  it('describeFilteredEmpty renders sentences from the kit bundle around a noun from the app bundle', () => {
    const search = describeFilteredEmpty('ui.dataView.noun.holdings', 'sol', []);
    expect(search.title).toBe('No holdings match “sol”');

    const filtered = describeFilteredEmpty('ui.dataView.noun.payments', '', [
      { key: 'status', label: 'Status', value: 'Active' },
    ]);
    expect(filtered.title).toBe('No payments match those filters');
    expect(filtered.description).toContain('Status: Active');

    const partial = describeFilteredEmpty('ui.dataView.noun.holdings', '', [], 25);
    expect(partial.description).toContain('25 holdings');

    for (const copy of [search, filtered, partial]) {
      expect(copy.title).not.toMatch(RAW_UI_KEY);
      expect(copy.description ?? '').not.toMatch(RAW_UI_KEY);
    }
  });

  it('resolves an option label from either bundle', () => {
    // The app's own — a `payments` filter option, declared in `RecurringList`.
    expect(
      filterOptionLabel({ value: 'active', labelKey: 'ui.dataView.payments.option.active' })
    ).toBe('Active');
    // The kit's own. `UiTranslationKey` is `ui.${string}` and spans both
    // bundles, so a def MAY name a key the app's instance cannot reach.
    expect(filterOptionLabel({ value: 'x', labelKey: 'ui.dataView.refine.clearAll' })).not.toMatch(
      RAW_UI_KEY
    );
  });

  it('resolveActiveFilters resolves both halves of every chip', () => {
    const defs = [
      {
        key: 'status',
        labelKey: 'ui.dataView.payments.filter.status' as UiTranslationKey,
        options: [
          { value: 'active', labelKey: 'ui.dataView.payments.option.active' as UiTranslationKey },
        ],
      },
    ] as unknown as V3FilterDef[];

    expect(resolveActiveFilters({ status: 'active' }, defs)).toEqual([
      { key: 'status', label: 'Status', value: 'Active' },
    ]);
  });
});
