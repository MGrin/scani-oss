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
import type { RouterOutputs } from '@/lib/trpc';

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
 */

export type AccountExport = RouterOutputs['exports']['everything'];

type Row<K extends keyof AccountExport> = AccountExport[K] extends readonly (infer T)[] ? T : never;

const accounts: ExportField<Row<'accounts'>>[] = [
  { header: 'Account', value: (row) => exportText(row.name) },
  { header: 'Institution', value: (row) => exportText(row.institutionName) },
  { header: 'Type', value: (row) => exportText(row.type) },
  { header: 'Description', value: (row) => exportText(row.description) },
  { header: 'Hidden', value: (row) => exportText(row.isHidden ? 'yes' : 'no') },
  { header: 'Active', value: (row) => exportText(row.isActive ? 'yes' : 'no') },
  { header: 'Added', value: (row) => exportDateTime(row.createdAt) },
  { header: 'Id', value: (row) => exportText(row.id) },
];

const holdings: ExportField<Row<'holdings'>>[] = [
  { header: 'Symbol', value: (row) => exportText(row.symbol) },
  { header: 'Token', value: (row) => exportText(row.tokenName) },
  { header: 'Account', value: (row) => exportText(row.accountName) },
  { header: 'Institution', value: (row) => exportText(row.institutionName) },
  // No `decimals`: a balance's precision is a property of the balance, and
  // rounding one to fit a column is how a token quantity becomes wrong.
  { header: 'Balance', value: (row) => exportNumber(row.balance) },
  { header: 'Source', value: (row) => exportText(row.source) },
  { header: 'Hidden', value: (row) => exportText(row.isHidden ? 'yes' : 'no') },
  { header: 'Active', value: (row) => exportText(row.isActive ? 'yes' : 'no') },
  { header: 'Last updated', value: (row) => exportDateTime(row.lastUpdated) },
  { header: 'Id', value: (row) => exportText(row.id) },
];

const transactions: ExportField<Row<'transactions'>>[] = [
  { header: 'Occurred', value: (row) => exportDateTime(row.occurredAt) },
  { header: 'Symbol', value: (row) => exportText(row.symbol) },
  { header: 'Account', value: (row) => exportText(row.accountName) },
  { header: 'Kind', value: (row) => exportText(row.kind) },
  // Signed, as stored: a ledger where an outflow is positive is a ledger that
  // does not add up.
  { header: 'Quantity', value: (row) => exportNumber(row.quantity) },
  { header: 'Price (native)', value: (row) => exportNumber(row.priceNative) },
  { header: 'Counter quantity', value: (row) => exportNumber(row.counterQuantity) },
  { header: 'Fee', value: (row) => exportNumber(row.feeQuantity) },
  { header: 'Counterparty', value: (row) => exportText(row.counterparty) },
  { header: 'Description', value: (row) => exportText(row.description) },
  { header: 'Source', value: (row) => exportText(row.source) },
  { header: 'External id', value: (row) => exportText(row.externalId) },
];

const vendors: ExportField<Row<'vendors'>>[] = [
  { header: 'Vendor', value: (row) => exportText(row.displayName) },
  { header: 'Category', value: (row) => exportText(row.category) },
  { header: 'Website', value: (row) => exportText(row.website) },
  { header: 'Added', value: (row) => exportDateTime(row.createdAt) },
];

const payments: ExportField<Row<'payments'>>[] = [
  { header: 'Vendor', value: (row) => exportText(row.vendorName) },
  { header: 'Direction', value: (row) => exportText(row.direction) },
  { header: 'Kind', value: (row) => exportText(row.kind) },
  { header: 'Amount', value: (row) => exportMoney(row.expectedAmount, row.currency) },
  {
    header: 'Every',
    value: (row) => exportText(`${row.intervalCount} ${row.intervalUnit}`),
  },
  { header: 'Starting', value: (row) => exportDate(row.anchorDate) },
  { header: 'Ending', value: (row) => exportDate(row.endDate) },
  { header: 'Status', value: (row) => exportText(row.status) },
  { header: 'Origin', value: (row) => exportText(row.origin) },
  { header: 'Notes', value: (row) => exportText(row.notes) },
];

const occurrences: ExportField<Row<'paymentOccurrences'>>[] = [
  { header: 'Vendor', value: (row) => exportText(row.vendor) },
  { header: 'Due', value: (row) => exportDate(row.dueDate) },
  { header: 'Status', value: (row) => exportText(row.status) },
  { header: 'Expected', value: (row) => exportNumber(row.expectedAmount) },
  { header: 'Actual', value: (row) => exportNumber(row.actualAmount) },
];

const groups: ExportField<Row<'groups'>>[] = [
  { header: 'Group', value: (row) => exportText(row.name) },
  { header: 'Description', value: (row) => exportText(row.description) },
  { header: 'Active', value: (row) => exportText(row.isActive ? 'yes' : 'no') },
];

const groupMembers: ExportField<Row<'groupMembers'>>[] = [
  { header: 'Group', value: (row) => exportText(row.group) },
  { header: 'Member kind', value: (row) => exportText(row.memberKind) },
  { header: 'Member', value: (row) => exportText(row.member) },
];

const vaults: ExportField<Row<'vaults'>>[] = [
  { header: 'Vault', value: (row) => exportText(row.name) },
  { header: 'Description', value: (row) => exportText(row.description) },
  { header: 'Saved', value: (row) => exportMoney(row.currentAmount, row.currency) },
  { header: 'Target', value: (row) => exportMoney(row.targetAmount, row.currency) },
  { header: 'Active', value: (row) => exportText(row.isActive ? 'yes' : 'no') },
];

const vaultHoldings: ExportField<Row<'vaultHoldings'>>[] = [
  { header: 'Vault', value: (row) => exportText(row.vault) },
  { header: 'Holding', value: (row) => exportText(row.holding) },
  { header: 'Share', value: (row) => exportNumber(row.percentage, 2) },
];

const documents: ExportField<Row<'documents'>>[] = [
  { header: 'File', value: (row) => exportText(row.filename) },
  { header: 'Kind', value: (row) => exportText(row.purpose) },
  { header: 'Type', value: (row) => exportText(row.mimeType) },
  // A file size is a tally, not a holding — it survives "Hide amounts".
  { header: 'Bytes', value: (row) => exportCount(row.byteSize) },
  { header: 'Source', value: (row) => exportText(row.sourceKind) },
  { header: 'Classification', value: (row) => exportText(row.classification) },
  { header: 'Uploaded', value: (row) => exportDateTime(row.createdAt) },
];

/** See `HistoryExport.dayTotal` — the rollup's 28-digit sums are division
 *  artifacts, and a workbook column of them arrives as unsummable text. The
 *  rounding that prevents that is `buildSheet`'s now, applied to every figure
 *  that declares a precision (SC-172); this column only has to declare one. */
const history: ExportField<Row<'netWorthDaily'>>[] = [
  { header: 'Date', value: (row) => exportDate(row.date) },
  { header: 'Net worth', value: (row) => exportNumber(row.totalValue, 2) },
  { header: 'Coverage', value: (row) => exportText(row.coverageQuality) },
  { header: 'Holdings priced', value: (row) => exportCount(row.holdingsWithKnownValue) },
  { header: 'Holdings total', value: (row) => exportCount(row.holdingsTotal) },
  // Same column, same order, same header as the home chart's CSV — the
  // two files get laid side by side, and SC-98 was exactly what happens
  // when they drift.
  { header: 'Holdings unpriceable', value: (row) => exportCount(row.holdingsUnpriceable) },
  {
    header: 'Holdings priced from a stale quote',
    value: (row) => exportCount(row.holdingsStalePriced),
  },
];

export function accountExportSheets(
  data: AccountExport,
  generatedAt: Date,
  options: { hideAmounts?: boolean } = {}
): ExportWorkbook {
  const { hideAmounts } = options;
  const sheet = <T>(name: string, fields: ExportField<T>[], rows: readonly T[]) =>
    buildSheet(name, fields, rows, { hideAmounts });

  return {
    sheets: [
      sheet('Accounts', accounts, data.accounts),
      sheet('Holdings', holdings, data.holdings),
      sheet('Transactions', transactions, data.transactions),
      sheet('Vendors', vendors, data.vendors),
      sheet('Payments', payments, data.payments),
      sheet('Payment occurrences', occurrences, data.paymentOccurrences),
      sheet('Groups', groups, data.groups),
      sheet('Group members', groupMembers, data.groupMembers),
      sheet('Vaults', vaults, data.vaults),
      sheet('Vault holdings', vaultHoldings, data.vaultHoldings),
      sheet('Documents', documents, data.documents),
      sheet('Net worth history', history, data.netWorthDaily),
    ],
    provenance: {
      subject: 'Whole account',
      scope: `${data.holdings.length} holdings, ${data.transactions.length} transactions, ${data.netWorthDaily.length} days of history`,
      generatedAt,
      amountsWithheld: hideAmounts,
      details: [
        { label: 'Account', value: data.profile.email },
        // Stated in the file itself, not only in the interface that produced
        // it: someone opening this backup in two years has the workbook and
        // nothing else, and an omission they cannot see is one they will
        // assume is not there.
        {
          label: 'Not included',
          value: 'Exchange and brokerage credentials, sessions, uploaded file contents',
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
