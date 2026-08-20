import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { jobLabelFor } from '../../../src/v3/lib/job-labels';

const t = i18n.t.bind(i18n);

/**
 * The English these produce is the English v2's hardcoded table produced —
 * the whole claim of the move (SC-320), and checkable because the strings are
 * asserted here rather than compared against the file they came from.
 *
 * `i18n.t` rather than a stub: a stub would only prove the function reaches
 * for a key, while the real one proves the key is in `en.json`. A missing key
 * resolves to itself, so a typo would put `v3.jobs.label.walletImport` on the
 * jobs list and nothing would throw.
 */
describe('jobLabelFor', () => {
  test.each([
    ['wallet-import', 'Wallet import'],
    ['exchange-import', 'Exchange import'],
    ['screenshot-parse', 'Document parse'],
    ['document-parse', 'Invoice parse'],
    ['file-import', 'File import'],
    ['manual-holdings-create', 'Manual holdings'],
    ['portfolio-history-backfill', 'History backfill'],
    ['holding-price-update', 'Price refresh'],
    ['user-data-delete', 'Account deletion'],
    ['transaction-import', 'Transaction history import'],
  ])('%p reads as %p', (jobName, label) => {
    expect(jobLabelFor(t, jobName).label).toBe(label);
  });

  test('every known job name carries an icon', () => {
    expect(jobLabelFor(t, 'wallet-import').icon).toBeDefined();
  });

  // A queue that has grown a name this table has not is better read as
  // `refund-reconcile` than under a label shared with every other unknown.
  test('an unrecognised job name renders as itself', () => {
    expect(jobLabelFor(t, 'refund-reconcile').label).toBe('refund-reconcile');
    expect(jobLabelFor(t, 'refund-reconcile').icon).toBeDefined();
  });
});
