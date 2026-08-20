import { describe, expect, test } from 'bun:test';
import { addUiLocale, uiT } from '../../../src/i18n';
import {
  filterOptionLabel,
  type UiTranslationKey,
  type V3FilterOption,
} from '../../../src/v3/lib/data-view';

/**
 * The discriminator, and the property that makes it worth having (SC-266).
 *
 * SC-262 left `options[].label` as text because typing it as a key would have
 * made the type lie about most of its instances: i18next resolves an unknown
 * key to *itself*, so a vendor's name passed as a key renders perfectly while
 * the type claims translation, and a genuine typo is indistinguishable from a
 * vendor called `ui.dataView.x.y`.
 *
 * **The `@ts-expect-error` lines below are the test.** They are checked by
 * `bun run type-check`, not by `bun test` — an unused `@ts-expect-error` is
 * itself a compile error, so each one FAILS THE BUILD the day its line starts
 * compiling. That is the loud failure the ticket asked for: the mistake cannot
 * reach a screen, because it cannot reach a build.
 *
 * The runtime assertions underneath only pin what the two branches render.
 */

// Real values, ANNOTATED `string` rather than inferred as literals: the whole
// point is that a value the compiler only knows to be a `string` cannot be a
// key. `declare const` would have been erased and blown up at runtime.
const vendorName: string = 'Kraken';
const suffix: string = 'y';

/** A literal under the kit's namespace — the only thing that may be a key. */
const declared: UiTranslationKey = 'ui.dataView.keys.option.active';

/** A key built at runtime is still fine, as long as the prefix is fixed. */
const composed: UiTranslationKey = `ui.dataView.x.${suffix}`;

// DATA as a key. This is the mistake that renders correctly and lies.
// @ts-expect-error a plain `string` is not a `ui.` key
const dataAsKey: UiTranslationKey = vendorName;

// The app's namespace, which the kit's i18next instance never receives.
// @ts-expect-error `v3.` keys are the app's, not the kit's
const wrongNamespace: UiTranslationKey = 'v3.holdings.filter.type';

// The union: an option is text OR a key, and the call site says which.
const dataOption: V3FilterOption = { value: 'inst-1', label: vendorName };
const copyOption: V3FilterOption = {
  value: 'active',
  labelKey: 'ui.dataView.keys.option.active',
};

// @ts-expect-error `labelKey` cannot carry data
const smuggled: V3FilterOption = { value: 'inst-1', labelKey: vendorName };

// @ts-expect-error an option is one or the other, never both
const both: V3FilterOption = { value: 'x', label: 'X', labelKey: 'ui.dataView.x.y' };

addUiLocale('en', {
  ui: { dataView: { keys: { option: { active: 'Active' } }, x: { y: 'Y' } } },
});

describe('the two branches render what they say', () => {
  test('a key branch resolves', () => {
    expect(filterOptionLabel(copyOption)).toBe('Active');
  });

  test('a text branch is handed through untouched', () => {
    // Deliberately a string that LOOKS like a key: the text branch must not
    // try to resolve it, or a vendor literally called `ui.dataView.x.y` would
    // render as "Y".
    expect(filterOptionLabel({ value: 'v', label: 'ui.dataView.x.y' })).toBe('ui.dataView.x.y');
  });

  test('the declared and composed keys are usable, so the type is not merely restrictive', () => {
    expect(uiT(declared)).toBe('Active');
    expect(typeof composed).toBe('string');
  });
});

// Referenced so the compiler keeps checking them and lint does not strip them.
export { both, dataAsKey, dataOption, smuggled, wrongNamespace };
