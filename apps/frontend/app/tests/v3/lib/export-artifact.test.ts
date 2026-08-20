import '../../i18n-preload';

import { describe, expect, it } from 'bun:test';
import { exportDate, exportMoney } from '@scani/ui/v3/lib/export/cell';
import { toExportBlob } from '@scani/ui/v3/lib/export/format';
import { buildSheet, type ExportField } from '@scani/ui/v3/lib/export/workbook';
import i18n from 'i18next';
import { type AccountExport, accountExportSheets } from '../../../src/v3/lib/account-export';

/**
 * The bytes of a file a reader downloads, asserted as bytes (SC-316).
 *
 * Every other test in this area asserts that a key *resolves*, which is a fact
 * about a bundle. This one asserts what a person opens. The artifact it was
 * written against — a real CSV, built through this exact path while the export
 * helpers still took the caller's `t` — carried five raw keys as its LABELS,
 * correct values under internal identifiers:
 *
 *     # ui.export.provenance.exportedFrom: Scani
 *     # ui.export.provenance.subject: Whole account
 *     # ui.export.provenance.scope: everything
 *     # ui.export.provenance.generated: 2026-08-16T00:00:00.000Z
 *     # ui.export.provenance.rows: 1
 *
 * The preamble labels come from `@scani/ui`'s bundle and the sheet's own
 * headers come from the app's, so a file that is clean here proves one export
 * reached both instances correctly — which is the thing the removed `t`
 * parameter used to let a caller get wrong, silently, into a file that
 * outlives the screen it left.
 */

/** The app's own `t`, from the instance the preload initialises — the same one
 *  both export components hold, and the one that holds none of the kit's
 *  `ui.*` keys. */
const t = i18n.t.bind(i18n);

/** A `ui.`-prefixed identifier that reached the file instead of its copy. */
const RAW_UI_KEY = /\bui\.[a-z][a-zA-Z]*\.[a-zA-Z.]+/;

const GENERATED_AT = new Date('2026-08-16T00:00:00.000Z');

interface HistoryPoint {
  date: Date;
  value: string;
}

/** The net-worth history export, shaped exactly as `HistoryExport.tsx` builds
 *  it: the app names the sheet and its columns, the kit writes the preamble. */
function historyWorkbook() {
  const fields: ExportField<HistoryPoint>[] = [
    { header: t('v3.export.column.date'), value: (point) => exportDate(point.date) },
    { header: t('v3.export.column.netWorth'), value: (point) => exportMoney(point.value, 'USD') },
  ];
  return {
    sheets: [
      buildSheet(t('v3.export.sheet.netWorth'), fields, [{ date: GENERATED_AT, value: '1234.56' }]),
    ],
    provenance: {
      subject: t('v3.home.historyExport.subject'),
      scope: t('v3.home.historyExport.days', { count: 90 }),
      generatedAt: GENERATED_AT,
      rowCount: 1,
      amountsWithheld: false,
      details: [{ label: t('v3.home.historyExport.currency'), value: 'USD' }],
    },
  };
}

/** The whole-account export, shaped as `DataExportSettings.tsx` builds it. The
 *  rows are empty on purpose — the labels are what this file is about, and an
 *  empty account still produces every sheet, header and provenance line.
 *  Cast as the neighbouring `account-export.test.ts` does: the wire type is a
 *  tRPC router output and cannot be written out by hand. */
const EMPTY_ACCOUNT = {
  profile: { email: 'a@b.c', name: 'A', baseCurrency: 'usd-id', createdAt: new Date(0) },
  accounts: [],
  holdings: [],
  transactions: [],
  vendors: [],
  payments: [],
  paymentOccurrences: [],
  groups: [],
  groupMembers: [],
  vaults: [],
  vaultHoldings: [],
  documents: [],
  netWorthDaily: [],
} as unknown as AccountExport;

describe('exported files carry copy, not identifiers', () => {
  it('writes no raw ui.* key into a net-worth history CSV', async () => {
    const blob = await toExportBlob(historyWorkbook(), 'csv', ',');

    expect(await blob.text()).not.toMatch(RAW_UI_KEY);
  });

  it('labels every provenance line in words', async () => {
    const blob = await toExportBlob(historyWorkbook(), 'csv', ',');
    const preamble = (await blob.text())
      .split('\r\n')
      .filter((line) => line.startsWith('#'))
      .join('\n');

    // The five labels from the measured artifact, as words. Asserted literally
    // rather than through `t`, so the test cannot agree with a bundle that has
    // drifted — the point is what the reader sees.
    expect(preamble).toContain('# Exported from: Scani');
    expect(preamble).toContain('# Subject: Net worth history');
    expect(preamble).toContain('# Scope: 90 days');
    expect(preamble).toContain('# Generated: 2026-08-16T00:00:00.000Z');
    expect(preamble).toContain('# Rows: 1');
  });

  it('writes no raw ui.* key into a whole-account CSV', async () => {
    const blob = await toExportBlob(
      accountExportSheets(EMPTY_ACCOUNT, GENERATED_AT, t),
      'csv',
      ','
    );

    expect(await blob.text()).not.toMatch(RAW_UI_KEY);
  });
});
