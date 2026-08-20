import {
  exportCount,
  exportDate,
  exportDateTime,
  exportMoney,
  exportNumber,
  exportText,
} from '@scani/ui/v3/lib/export/cell';
import type { ExportWorkbook } from '@scani/ui/v3/lib/export/format';
import { buildSheet, type ExportField } from '@scani/ui/v3/lib/export/workbook';
import type { TFunction } from 'i18next';
import type { RouterOutputs } from '@/lib/trpc';
import { formatIntervalUnits } from './paymentTotals';

/**
 * The whole-account payload, laid out as a workbook.
 *
 * Pure and separate from the button that triggers it, so the *shape of the
 * file* — which sets it contains, what each column means, whether a figure
 * arrives as a figure — is checkable in a test rather than only by downloading
 * it and opening Excel. That matters more here than anywhere else in the
 * export: this is the file someone leaves the product with, and a column that
 * silently stopped being populated is the kind of defect that is discovered by
 * the person who no longer has the account.
 *
 * One sheet per set, in the order a person would read them: who and what they
 * own, then what happened, then the money that recurs, then the organising
 * layers, then the history. `About` last, because it is a caption.
 *
 * Every table below is a FUNCTION of `t` rather than a module constant
 * (SC-201). A column header is a string a person reads in a spreadsheet, so it
 * belongs in `en.json` like any other — but `ExportField.header` is consumed
 * as a resolved string by `buildSheet` in `@scani/ui`, and giving it a
 * `headerKey` would push i18n into a package with no `t` and other consumers.
 * Taking `t` here keeps the tables declarative and the shared primitive
 * unchanged.
 *
 * The seven history columns share their keys with `HistoryExport`'s CSV, which
 * is not tidiness: the two files get laid side by side, both claim the same
 * columns in the same order, and SC-98 is what happened when they drifted in
 * English alone. One key each is the only version of that promise a translator
 * cannot break.
 */

export type AccountExport = RouterOutputs['exports']['everything'];

type Row<K extends keyof AccountExport> = AccountExport[K] extends readonly (infer T)[] ? T : never;

/** "yes" / "no" as a cell. Its own key pair rather than a boolean rendered
 *  inline: a spreadsheet column of them is read as data, and a language whose
 *  affirmative is not three letters needs to say so once. */
/**
 * "2 months", not "2 month".
 *
 * The cell used to be one key, `{{count}} {{unit}}`, with `unit` interpolated
 * straight from the wire — so every account export downloaded to date reads
 * "2 month" in the only language we ship (SC-235). The per-unit plural shape
 * that replaced it is shared with the Money tab's cadence line now (SC-320),
 * which had the same defect; only the key namespace differs, because a cell
 * reads "2 months" and a cadence reads "Every 2 months".
 */
export function formatInterval(t: TFunction, unit: string, count: number): string {
  return formatIntervalUnits(t, 'v3.export.value', unit, count);
}

const yesNo = (t: TFunction, value: boolean) =>
  exportText(value ? t('v3.export.value.yes') : t('v3.export.value.no'));

const accounts = (t: TFunction): ExportField<Row<'accounts'>>[] => [
  { header: t('v3.export.column.account'), value: (row) => exportText(row.name) },
  { header: t('v3.export.column.institution'), value: (row) => exportText(row.institutionName) },
  { header: t('v3.export.column.accountType'), value: (row) => exportText(row.type) },
  { header: t('v3.export.column.description'), value: (row) => exportText(row.description) },
  { header: t('v3.export.column.hidden'), value: (row) => yesNo(t, row.isHidden) },
  { header: t('v3.export.column.active'), value: (row) => yesNo(t, row.isActive) },
  { header: t('v3.export.column.added'), value: (row) => exportDateTime(row.createdAt) },
  { header: t('v3.export.column.id'), value: (row) => exportText(row.id) },
];

const holdings = (t: TFunction): ExportField<Row<'holdings'>>[] => [
  { header: t('v3.export.column.symbol'), value: (row) => exportText(row.symbol) },
  { header: t('v3.export.column.token'), value: (row) => exportText(row.tokenName) },
  { header: t('v3.export.column.account'), value: (row) => exportText(row.accountName) },
  { header: t('v3.export.column.institution'), value: (row) => exportText(row.institutionName) },
  // No `decimals`: a balance's precision is a property of the balance, and
  // rounding one to fit a column is how a token quantity becomes wrong.
  { header: t('v3.export.column.balance'), value: (row) => exportNumber(row.balance) },
  { header: t('v3.export.column.source'), value: (row) => exportText(row.source) },
  { header: t('v3.export.column.hidden'), value: (row) => yesNo(t, row.isHidden) },
  { header: t('v3.export.column.active'), value: (row) => yesNo(t, row.isActive) },
  { header: t('v3.export.column.lastUpdated'), value: (row) => exportDateTime(row.lastUpdated) },
  { header: t('v3.export.column.id'), value: (row) => exportText(row.id) },
];

const transactions = (t: TFunction): ExportField<Row<'transactions'>>[] => [
  { header: t('v3.export.column.occurred'), value: (row) => exportDateTime(row.occurredAt) },
  { header: t('v3.export.column.symbol'), value: (row) => exportText(row.symbol) },
  { header: t('v3.export.column.account'), value: (row) => exportText(row.accountName) },
  { header: t('v3.export.column.transactionKind'), value: (row) => exportText(row.kind) },
  // Signed, as stored: a ledger where an outflow is positive is a ledger that
  // does not add up.
  { header: t('v3.export.column.quantity'), value: (row) => exportNumber(row.quantity) },
  { header: t('v3.export.column.priceNative'), value: (row) => exportNumber(row.priceNative) },
  {
    header: t('v3.export.column.counterQuantity'),
    value: (row) => exportNumber(row.counterQuantity),
  },
  { header: t('v3.export.column.fee'), value: (row) => exportNumber(row.feeQuantity) },
  { header: t('v3.export.column.counterparty'), value: (row) => exportText(row.counterparty) },
  { header: t('v3.export.column.description'), value: (row) => exportText(row.description) },
  { header: t('v3.export.column.source'), value: (row) => exportText(row.source) },
  { header: t('v3.export.column.externalId'), value: (row) => exportText(row.externalId) },
];

const vendors = (t: TFunction): ExportField<Row<'vendors'>>[] => [
  { header: t('v3.export.column.vendor'), value: (row) => exportText(row.displayName) },
  { header: t('v3.export.column.category'), value: (row) => exportText(row.category) },
  { header: t('v3.export.column.website'), value: (row) => exportText(row.website) },
  { header: t('v3.export.column.added'), value: (row) => exportDateTime(row.createdAt) },
];

const payments = (t: TFunction): ExportField<Row<'payments'>>[] => [
  { header: t('v3.export.column.vendor'), value: (row) => exportText(row.vendorName) },
  { header: t('v3.export.column.direction'), value: (row) => exportText(row.direction) },
  { header: t('v3.export.column.paymentKind'), value: (row) => exportText(row.kind) },
  {
    header: t('v3.export.column.amount'),
    value: (row) => exportMoney(row.expectedAmount, row.currency),
  },
  {
    header: t('v3.export.column.every'),
    value: (row) => exportText(formatInterval(t, row.intervalUnit, row.intervalCount)),
  },
  { header: t('v3.export.column.starting'), value: (row) => exportDate(row.anchorDate) },
  { header: t('v3.export.column.ending'), value: (row) => exportDate(row.endDate) },
  { header: t('v3.export.column.status'), value: (row) => exportText(row.status) },
  { header: t('v3.export.column.origin'), value: (row) => exportText(row.origin) },
  { header: t('v3.export.column.notes'), value: (row) => exportText(row.notes) },
];

const occurrences = (t: TFunction): ExportField<Row<'paymentOccurrences'>>[] => [
  { header: t('v3.export.column.vendor'), value: (row) => exportText(row.vendor) },
  { header: t('v3.export.column.due'), value: (row) => exportDate(row.dueDate) },
  { header: t('v3.export.column.status'), value: (row) => exportText(row.status) },
  { header: t('v3.export.column.expected'), value: (row) => exportNumber(row.expectedAmount) },
  { header: t('v3.export.column.actual'), value: (row) => exportNumber(row.actualAmount) },
];

const groups = (t: TFunction): ExportField<Row<'groups'>>[] => [
  { header: t('v3.export.column.group'), value: (row) => exportText(row.name) },
  { header: t('v3.export.column.description'), value: (row) => exportText(row.description) },
  { header: t('v3.export.column.active'), value: (row) => yesNo(t, row.isActive) },
];

const groupMembers = (t: TFunction): ExportField<Row<'groupMembers'>>[] => [
  { header: t('v3.export.column.group'), value: (row) => exportText(row.group) },
  { header: t('v3.export.column.memberKind'), value: (row) => exportText(row.memberKind) },
  { header: t('v3.export.column.member'), value: (row) => exportText(row.member) },
];

const vaults = (t: TFunction): ExportField<Row<'vaults'>>[] => [
  { header: t('v3.export.column.vault'), value: (row) => exportText(row.name) },
  { header: t('v3.export.column.description'), value: (row) => exportText(row.description) },
  {
    header: t('v3.export.column.saved'),
    value: (row) => exportMoney(row.currentAmount, row.currency),
  },
  {
    header: t('v3.export.column.target'),
    value: (row) => exportMoney(row.targetAmount, row.currency),
  },
  { header: t('v3.export.column.active'), value: (row) => yesNo(t, row.isActive) },
];

const vaultHoldings = (t: TFunction): ExportField<Row<'vaultHoldings'>>[] => [
  { header: t('v3.export.column.vault'), value: (row) => exportText(row.vault) },
  { header: t('v3.export.column.holding'), value: (row) => exportText(row.holding) },
  // `share` and not a reused "percentage": this column is a proportion OF a
  // vault, and the word that carries that is not the word for a percentage
  // sign in every language.
  { header: t('v3.export.column.share'), value: (row) => exportNumber(row.percentage, 2) },
];

const documents = (t: TFunction): ExportField<Row<'documents'>>[] => [
  { header: t('v3.export.column.file'), value: (row) => exportText(row.filename) },
  { header: t('v3.export.column.documentKind'), value: (row) => exportText(row.purpose) },
  { header: t('v3.export.column.mimeType'), value: (row) => exportText(row.mimeType) },
  // A file size is a tally, not a holding — it survives "Hide amounts".
  { header: t('v3.export.column.bytes'), value: (row) => exportCount(row.byteSize) },
  { header: t('v3.export.column.source'), value: (row) => exportText(row.sourceKind) },
  {
    header: t('v3.export.column.classification'),
    value: (row) => exportText(row.classification),
  },
  { header: t('v3.export.column.uploaded'), value: (row) => exportDateTime(row.createdAt) },
];

/** See `HistoryExport.dayTotal` — the rollup's 28-digit sums are division
 *  artifacts, and a workbook column of them arrives as unsummable text. The
 *  rounding that prevents that is `buildSheet`'s now, applied to every figure
 *  that declares a precision (SC-172); this column only has to declare one. */
const history = (t: TFunction): ExportField<Row<'netWorthDaily'>>[] => [
  { header: t('v3.export.column.date'), value: (row) => exportDate(row.date) },
  { header: t('v3.export.column.netWorth'), value: (row) => exportNumber(row.totalValue, 2) },
  { header: t('v3.export.column.coverage'), value: (row) => exportText(row.coverageQuality) },
  {
    header: t('v3.export.column.holdingsPriced'),
    value: (row) => exportCount(row.holdingsWithKnownValue),
  },
  { header: t('v3.export.column.holdingsTotal'), value: (row) => exportCount(row.holdingsTotal) },
  // Same column, same order, same KEY as the home chart's CSV — the two files
  // get laid side by side, and SC-98 was exactly what happens when they
  // drift. Sharing the key is what makes that promise survive translation.
  {
    header: t('v3.export.column.holdingsUnpriceable'),
    value: (row) => exportCount(row.holdingsUnpriceable),
  },
  {
    header: t('v3.export.column.holdingsStalePriced'),
    value: (row) => exportCount(row.holdingsStalePriced),
  },
];

export function accountExportSheets(
  data: AccountExport,
  generatedAt: Date,
  t: TFunction,
  options: { hideAmounts?: boolean } = {}
): ExportWorkbook {
  const { hideAmounts } = options;
  const sheet = <T>(name: string, fields: ExportField<T>[], rows: readonly T[]) =>
    buildSheet(name, fields, rows, { hideAmounts });

  return {
    sheets: [
      sheet(t('v3.export.sheet.accounts'), accounts(t), data.accounts),
      sheet(t('v3.export.sheet.holdings'), holdings(t), data.holdings),
      sheet(t('v3.export.sheet.transactions'), transactions(t), data.transactions),
      sheet(t('v3.export.sheet.vendors'), vendors(t), data.vendors),
      sheet(t('v3.export.sheet.payments'), payments(t), data.payments),
      sheet(t('v3.export.sheet.occurrences'), occurrences(t), data.paymentOccurrences),
      sheet(t('v3.export.sheet.groups'), groups(t), data.groups),
      sheet(t('v3.export.sheet.groupMembers'), groupMembers(t), data.groupMembers),
      sheet(t('v3.export.sheet.vaults'), vaults(t), data.vaults),
      sheet(t('v3.export.sheet.vaultHoldings'), vaultHoldings(t), data.vaultHoldings),
      sheet(t('v3.export.sheet.documents'), documents(t), data.documents),
      sheet(t('v3.export.sheet.history'), history(t), data.netWorthDaily),
    ],
    provenance: {
      subject: t('v3.export.provenance.subject'),
      // Three counts in one sentence, so three pluralised clause keys and a
      // frame — i18next pluralises on ONE count, and these three vary
      // independently (SC-201). The frame also owns the punctuation, which is
      // where a language that does not separate list items with commas gets
      // to say so.
      scope: t('v3.export.provenance.scope', {
        holdings: t('v3.export.provenance.scopeHoldings', { count: data.holdings.length }),
        transactions: t('v3.export.provenance.scopeTransactions', {
          count: data.transactions.length,
        }),
        history: t('v3.export.provenance.scopeHistory', { count: data.netWorthDaily.length }),
      }),
      generatedAt,
      amountsWithheld: hideAmounts,
      details: [
        { label: t('v3.export.provenance.accountLabel'), value: data.profile.email },
        // Stated in the file itself, not only in the interface that produced
        // it: someone opening this backup in two years has the workbook and
        // nothing else, and an omission they cannot see is one they will
        // assume is not there.
        {
          label: t('v3.export.provenance.notIncludedLabel'),
          value: t('v3.export.provenance.notIncludedValue'),
        },
      ],
    },
  };
}

/**
 * The same withholding, applied to the machine copy.
 *
 * The JSON download sits in the *same dialog* as the workbook, under the same
 * toggle, so it has to honour it — a "Hide amounts" that redacts the
 * spreadsheet and hands over an unredacted JSON beside it is not a privacy
 * control, it is a trap. `buildSheet` cannot help here: it works on resolved
 * cells, and this payload never becomes cells.
 *
 * Named fields rather than a key-name pattern. A regex over keys reads as more
 * thorough and is not: `/value/` catches `holdingsWithKnownValue`, which is a
 * count, while missing anything the API later calls `notional` or `basis`. An
 * explicit list is checkable against the router by eye, and
 * `account-export.test.ts` asserts that nothing on this list survives.
 */
const WITHHELD_FIELDS = {
  holdings: ['balance'],
  transactions: ['quantity', 'priceNative', 'counterQuantity', 'feeQuantity'],
  payments: ['expectedAmount'],
  paymentOccurrences: ['expectedAmount', 'actualAmount'],
  vaults: ['targetAmount', 'currentAmount'],
  vaultHoldings: ['percentage'],
  netWorthDaily: ['totalValue'],
} as const satisfies Partial<Record<keyof AccountExport, readonly string[]>>;

export function withheldAccount(data: AccountExport): AccountExport {
  const out = { ...data } as Record<string, unknown>;
  for (const [set, fields] of Object.entries(WITHHELD_FIELDS)) {
    const rows = out[set];
    if (!Array.isArray(rows)) continue;
    out[set] = rows.map((row: Record<string, unknown>) => {
      const copy = { ...row };
      for (const field of fields) delete copy[field];
      return copy;
    });
  }
  return out as AccountExport;
}
