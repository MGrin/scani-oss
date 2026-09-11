import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { COST_BASIS_METHODS } from '@scani/shared';
import i18n from 'i18next';
import {
  costBasisChangeRequest,
  costBasisMethodLabel,
  costBasisMethodOptions,
} from '../../../src/v3/lib/costBasis';

/**
 * SC-980 — the two halves of the cost-basis block that do not need a screen.
 *
 * The copy is asserted against the real `en.json` through the preload, so what
 * is checked here is the English that ships rather than a second copy of it.
 */

const t = i18n.t.bind(i18n);

describe('the method has a name a reader could recognise', () => {
  test('every method the contract declares is labelled', () => {
    for (const method of COST_BASIS_METHODS) {
      const label = costBasisMethodLabel(t, method);
      // i18next resolves a missing key to the key itself, so this is the whole
      // failure mode: `v3.settings.costBasis.method.fifo` rendered on a
      // settings page, with nothing thrown and nothing logged.
      expect(label).not.toBe(`v3.settings.costBasis.method.${method}`);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('the label carries the identifier as well as the name', () => {
    // Both halves, because a reader who has met one of these from an
    // accountant has met exactly one of the two spellings.
    expect(costBasisMethodLabel(t, 'fifo')).toInclude('FIFO');
    expect(costBasisMethodLabel(t, 'fifo')).toInclude('First in');
    expect(costBasisMethodLabel(t, 'uk_section_104')).toInclude('Section 104');
  });

  test('CONTROL: a method that does not exist echoes its key', () => {
    // Without this the assertions above pass against a catalogue where every
    // lookup happens to return something.
    expect(t('v3.settings.costBasis.method.lifo')).toBe('v3.settings.costBasis.method.lifo');
  });

  test('the chooser offers every method, in the contract order', () => {
    expect(costBasisMethodOptions(t).map((o) => o.value)).toEqual([...COST_BASIS_METHODS]);
  });
});

describe('choosing the method already in force is not a change', () => {
  /**
   * The arm that writes NOTHING. `user_cost_basis_method_changes` carries a
   * `previous_method <> new_method` CHECK, so a same-method commit is a write
   * the database refuses — the reader would have confirmed a rewrite of a
   * year of their history and been told it failed.
   */
  test('the same method again yields no request', () => {
    expect(costBasisChangeRequest('fifo', 'fifo')).toBeNull();
    expect(costBasisChangeRequest('uk_section_104', 'uk_section_104')).toBeNull();
  });

  test('nothing chosen yet yields no request', () => {
    expect(costBasisChangeRequest('fifo', null)).toBeNull();
  });

  /** The arm that writes exactly ONE row. */
  test('a different method yields that method', () => {
    expect(costBasisChangeRequest('fifo', 'uk_section_104')).toBe('uk_section_104');
    expect(costBasisChangeRequest('uk_section_104', 'fifo')).toBe('fifo');
  });
});

describe('the confirmation says what changing it does, in one sentence', () => {
  const consequence = (count: number, method = 'UK Section 104 pooling') =>
    t('v3.settings.costBasis.consequence', { method, count });

  test('it names the method, the window, and what the reader will see move', () => {
    const copy = consequence(400);
    expect(copy).toInclude('UK Section 104 pooling');
    expect(copy).toInclude('400');
    // The three things mgrin's ruling requires it to say in a reader's terms:
    // the gains are recomputed, history already seen is rewritten, and the
    // figures on screen will change. "Change a setting" is what it must not be.
    expect(copy).toInclude('worked out again');
    expect(copy).toInclude('history you have already seen');
    expect(copy).toInclude('will show different numbers');
  });

  test('it is ONE key, so a translator is never handed a clause list (SC-1028)', () => {
    // The shape this guards against is a sentence assembled from fragments,
    // each of which looks translated while the sentence they make is not.
    // A single key with two values cannot be assembled wrongly.
    const copy = consequence(400);
    expect(copy).not.toInclude('{{');
    expect(copy).not.toInclude('}}');
    // Four sentences, not four keys.
    expect(copy.split('. ').length).toBeGreaterThan(2);
  });

  test('the day count agrees with itself in both plural forms', () => {
    expect(consequence(1)).toInclude('the 1 day of history');
    expect(consequence(400)).toInclude('roughly 400 days of history');
  });

  test('choosing the current method promises no rewrite at all', () => {
    // The consequence shown before a real choice has been made. It must not
    // describe the rewrite, because at that moment nothing would be rewritten.
    const copy = t('v3.settings.costBasis.consequenceUnchanged', { method: 'First in, first out' });
    expect(copy).toInclude('already');
    expect(copy).not.toInclude('worked out again');
  });

  test('the commit button is the act, not the trigger noun', () => {
    // `ConfirmAction`'s second rule: the second tap has to read as a different
    // act from the first. "Change…" opens it; this is what it does.
    const confirm = t('v3.settings.costBasis.changeConfirm', { method: 'FIFO' });
    expect(confirm).toInclude('Recalculate');
    expect(confirm).toInclude('FIFO');
    expect(confirm).not.toBe(t('v3.settings.costBasis.changeTrigger'));
  });

  test('the running state says the figures are still settling', () => {
    expect(t('v3.settings.costBasis.recomputing')).toInclude('still settling');
  });
});
