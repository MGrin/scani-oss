import { AI_COLUMN_MAPPING_WARNING, type CsvMapping, CsvMappingDto } from '@scani/shared';
import { rowsLost } from '@/v3/lib/budget-app-import';
import { savedAsCheck } from '@/v3/lib/holdings';

/**
 * The four remaining job results, read before they are rendered.
 *
 * Same split as `wallet-import.ts` and for the same reason: what a result MEANS
 * is a decision, and a decision made inside JSX is one nothing can assert. Each
 * reader here answers one question the renderer above it then only has to lay
 * out — how many rows there are, whether a figure exists at all, and what was
 * cut from a list that has a cap on it.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asFiniteNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * One line of a job result, with the key it can be translated under when the
 * server wrote one (SC-434).
 *
 * `text` is always the English the server produced, and a line with no `key`
 * renders it — that is the honest case, not a gap: an upstream refusal or a
 * parser's `row 4: no date column` is written by something outside this app.
 */
export interface JobLine {
  key: string | null;
  params?: Record<string, string | number>;
  /** Lists the key interpolates, each rendered item by item (SC-1028). */
  lists?: Record<string, JobLineList>;
  text: string;
}

interface JobLineList {
  type: 'conjunction' | 'disjunction';
  items: JobLine[];
}

/**
 * The keyed lines of a result, or the plain ones read the old way.
 *
 * Everything about this function is about what a YEAR-OLD ROW holds. 182
 * warning strings are already stored in `user_jobs.result` with no keys and
 * cannot be re-derived, so `warnings` is still the field that must be read
 * when `warningDetails` is absent — and it will be absent forever on those.
 * A detail entry that is not the shape we expect falls back to its own
 * `text`, and a details array that does not line up with `warnings` is
 * ignored wholesale rather than zipped: a mismatched pair would attach one
 * line's key to another line's sentence, which renders a confident wrong
 * sentence where the un-keyed read renders a correct English one.
 */
export function readJobLines(record: Record<string, unknown>): JobLine[] {
  const text = asStringList(record.warnings);
  const details = Array.isArray(record.warningDetails) ? record.warningDetails : null;
  if (!details || details.length !== text.length) return text.map(asPlainLine);
  return details.map((entry, index) => {
    const detail = asRecord(entry);
    const line = typeof detail.text === 'string' ? detail.text : text[index];
    if (line === undefined) return asPlainLine(text[index] ?? '');
    const key = typeof detail.key === 'string' ? detail.key : null;
    if (key === null) return { key: null, text: line };
    if (detail.lists === undefined) return { key, params: asParams(detail.params), text: line };
    const lists = asLists(detail.lists, LIST_DEPTH);
    // A key whose lists did not survive the read would render its `{{walks}}`
    // placeholder raw, so the line falls back to the server's sentence whole.
    return lists === null
      ? { key: null, text: line }
      : { key, params: asParams(detail.params), lists, text: line };
  });
}

/** The deepest nesting a producer writes is two (IBKR's blank-field clauses). */
const LIST_DEPTH = 3;

function asLists(value: unknown, depth: number): Record<string, JobLineList> | null {
  if (depth === 0 || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, JobLineList> = {};
  for (const [name, raw] of Object.entries(value)) {
    const list = asRecord(raw);
    if (list.type !== 'conjunction' && list.type !== 'disjunction') return null;
    if (!Array.isArray(list.items)) return null;
    const items: JobLine[] = [];
    for (const entry of list.items) {
      const item = asListItem(entry, depth - 1);
      if (item === null) return null;
      items.push(item);
    }
    out[name] = { type: list.type, items };
  }
  return out;
}

function asListItem(value: unknown, depth: number): JobLine | null {
  const item = asRecord(value);
  if (typeof item.text !== 'string') return null;
  if (item.key === null) return { key: null, text: item.text };
  if (typeof item.key !== 'string') return null;
  if (item.lists === undefined)
    return { key: item.key, params: asParams(item.params), text: item.text };
  const lists = asLists(item.lists, depth);
  return lists === null
    ? null
    : { key: item.key, params: asParams(item.params), lists, text: item.text };
}

type Translate = (key: string, options: Record<string, string | number>) => string;
type Resolves = (key: string, options: Record<string, string | number>) => boolean;

/**
 * The line a reader sees: translated when every key in it resolves, and the
 * server's English sentence whole when any one does not.
 *
 * All or nothing, because a partial render is the defect SC-1028 removed: a
 * Russian frame around one English clause reads worse than the English
 * sentence it replaces. `resolves` is asked with the params, since a plural
 * key exists only under its `_one`/`_other` forms.
 */
export function renderJobLine(
  line: JobLine,
  t: Translate,
  resolves: Resolves,
  language: string
): string {
  return translateLine(line, t, resolves, language) ?? line.text;
}

function translateLine(
  line: JobLine,
  t: Translate,
  resolves: Resolves,
  language: string
): string | null {
  if (line.key === null) return line.text;
  const params = { ...line.params };
  if (!resolves(line.key, params)) return null;
  for (const [name, list] of Object.entries(line.lists ?? {})) {
    const parts: string[] = [];
    for (const item of list.items) {
      const part = translateLine(item, t, resolves, language);
      if (part === null) return null;
      parts.push(part);
    }
    params[name] = new Intl.ListFormat(language, { type: list.type }).format(parts);
  }
  return t(line.key, params);
}

function asPlainLine(text: string): JobLine {
  return { key: null, text };
}

/** Only primitives cross the jsonb boundary; anything else is dropped. */
function asParams(value: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw)))
      out[key] = raw;
  }
  return out;
}

/**
 * A list rendered short, with what was cut counted rather than dropped.
 *
 * Every list in v2's job results slices to a cap and says nothing about the
 * remainder — `{n} warning(s)` above five lines, with four of them nowhere.
 * The count that IS stated is the full one, so the two silently disagree and
 * the reader has no way to know which lines they are looking at.
 */
export interface CappedList {
  shown: string[];
  remaining: number;
}

export function capList(items: readonly string[], cap: number): CappedList {
  return { shown: items.slice(0, cap), remaining: Math.max(0, items.length - cap) };
}

/** Provider-reported failures, one line each, whatever shape they arrived in. */
function readErrorLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const record = asRecord(entry);
    const message = typeof record.error === 'string' ? record.error : JSON.stringify(entry);
    const scope = typeof record.accountType === 'string' ? record.accountType : null;
    return scope ? `${scope}: ${message}` : message;
  });
}

// ── exchange-import ─────────────────────────────────────────────────────────

export interface ExchangeImportView {
  accountsCreated: number;
  holdingsImported: number;
  errors: string[];
  institutionId: string | null;
  /** Every account we reached reported nothing, and nothing failed. A fact,
   *  not a failure — and the one branch that needs saying out loud. */
  connectedButEmpty: boolean;
}

export function readExchangeImport(result: unknown): ExchangeImportView {
  const record = asRecord(result);
  const accountsCreated = asFiniteNumber(record.accountsCreated);
  const holdingsImported = asFiniteNumber(record.tokensImported);
  const errors = readErrorLines(record.errors);
  return {
    accountsCreated,
    holdingsImported,
    errors,
    institutionId: typeof record.institutionId === 'string' ? record.institutionId : null,
    connectedButEmpty: errors.length === 0 && holdingsImported === 0 && accountsCreated > 0,
  };
}

// ── file-import ─────────────────────────────────────────────────────────────

interface FileImportHolding {
  holdingId: string;
  symbol: string;
  name: string;
  transactionCount: number;
  /** The statement's own closing figure, canonical. `null` when the file
   *  carried none — which is not the same as a closing balance of zero. */
  closingBalance: string | null;
  /** Where the balance came from (SC-1324). A result written before that
   *  reads `unchanged`, which is what it was. */
  balanceFrom: FileImportBalanceFrom;
  /** The sum of the imported rows, set only when `balanceFrom` is `imported-rows`. */
  rowsBalance: string | null;
  isNew: boolean;
}

type FileImportBalanceFrom = 'statement-close' | 'imported-rows' | 'unknown' | 'unchanged';

const BALANCE_FROM: readonly FileImportBalanceFrom[] = [
  'statement-close',
  'imported-rows',
  'unknown',
  'unchanged',
];

export type FileImportDateOrder = 'day-first' | 'month-first';

export interface FileImportCurrencyPrompt {
  customMapping?: CsvMapping;
  r2Key: string;
  fileType: string;
  transactionCount: number;
  preview: Array<{ date: string; description: string; amount: number }>;
  /** Chosen on an earlier date-order prompt; the re-parse must keep it. */
  dateOrder?: FileImportDateOrder;
}

export interface FileImportDateOrderPrompt {
  customMapping?: CsvMapping;
  r2Key: string;
  fileType: string;
  rowCount: number;
  /** Raw, as the file spelled them — the reader recognises their own bank's dates. */
  samples: string[];
  defaultCurrency?: string;
}

function asDateOrder(value: unknown): FileImportDateOrder | undefined {
  return value === 'day-first' || value === 'month-first' ? value : undefined;
}

export interface FileImportColumnPrompt {
  r2Key: string;
  fileType: string;
  headers: string[];
  defaultCurrency?: string;
  dateOrder?: FileImportDateOrder;
}

function readMapping(value: unknown): CsvMapping | undefined {
  const result = CsvMappingDto.safeParse(value);
  return result.success ? result.data : undefined;
}

export interface FileImportView {
  needsColumnMapping: FileImportColumnPrompt | null;
  format: string;
  accountId: string;
  transactionCount: number;
  observationCount: number;
  newHoldingCount: number;
  holdings: FileImportHolding[];
  warnings: string[];
  /** The AI detector chose the CSV's columns — said as a fact, not counted as
   *  a warning (SC-1527). */
  columnsMatchedAutomatically: boolean;
  /** Set when the file carried no usable currency and the parse stopped. */
  needsCurrency: FileImportCurrencyPrompt | null;
  /** Set when nothing said whether `03/04` is day- or month-first (SC-1291). */
  needsDateOrder: FileImportDateOrderPrompt | null;
}

export function readFileImport(result: unknown): FileImportView | null {
  const record = asRecord(result);
  if (typeof record.accountId !== 'string') return null;
  if (typeof record.transactionCount !== 'number') return null;
  if (!Array.isArray(record.holdingsTouched)) return null;

  const created = new Set(asStringList(record.holdingsCreated));
  const needsCurrencyRaw = asRecord(record.needsCurrency);
  const hasCurrencyPrompt = typeof needsCurrencyRaw.r2Key === 'string';
  const needsDateOrderRaw = asRecord(record.needsDateOrder);
  const columns = asRecord(record.needsColumnMapping);
  const lines = asStringList(record.warnings);

  return {
    needsColumnMapping:
      typeof columns.r2Key === 'string'
        ? {
            r2Key: columns.r2Key,
            fileType: typeof columns.fileType === 'string' ? columns.fileType : 'csv',
            headers: asStringList(columns.headers),
            defaultCurrency:
              typeof columns.defaultCurrency === 'string' ? columns.defaultCurrency : undefined,
            dateOrder: asDateOrder(columns.dateOrder),
          }
        : null,
    format: typeof record.format === 'string' ? record.format : '',
    accountId: record.accountId,
    transactionCount: record.transactionCount,
    observationCount: asFiniteNumber(record.observationCount),
    newHoldingCount: created.size,
    holdings: record.holdingsTouched.map((entry) => {
      const holding = asRecord(entry);
      const holdingId = typeof holding.holdingId === 'string' ? holding.holdingId : '';
      return {
        holdingId,
        symbol: typeof holding.symbol === 'string' ? holding.symbol : '',
        name: typeof holding.name === 'string' ? holding.name : '',
        transactionCount: asFiniteNumber(holding.transactionCount),
        closingBalance:
          typeof holding.closingBalance === 'string' && holding.closingBalance.length > 0
            ? holding.closingBalance
            : null,
        balanceFrom: BALANCE_FROM.find((word) => word === holding.balanceFrom) ?? 'unchanged',
        rowsBalance:
          holding.balanceFrom === 'imported-rows' &&
          typeof holding.rowsBalance === 'string' &&
          holding.rowsBalance.length > 0
            ? holding.rowsBalance
            : null,
        isNew: created.has(holdingId),
      };
    }),
    warnings: lines.filter((line) => line !== AI_COLUMN_MAPPING_WARNING),
    columnsMatchedAutomatically: lines.includes(AI_COLUMN_MAPPING_WARNING),
    needsCurrency: hasCurrencyPrompt
      ? {
          customMapping: readMapping(needsCurrencyRaw.customMapping),
          r2Key: needsCurrencyRaw.r2Key as string,
          fileType: typeof needsCurrencyRaw.fileType === 'string' ? needsCurrencyRaw.fileType : '',
          transactionCount: asFiniteNumber(needsCurrencyRaw.transactionCount),
          preview: (Array.isArray(needsCurrencyRaw.transactionPreview)
            ? needsCurrencyRaw.transactionPreview
            : []
          ).map((entry) => {
            const row = asRecord(entry);
            return {
              date: typeof row.date === 'string' ? row.date : '',
              description: typeof row.description === 'string' ? row.description : '',
              amount: asFiniteNumber(row.amount),
            };
          }),
          dateOrder: asDateOrder(needsCurrencyRaw.dateOrder),
        }
      : null,
    needsDateOrder:
      typeof needsDateOrderRaw.r2Key === 'string'
        ? {
            customMapping: readMapping(needsDateOrderRaw.customMapping),
            r2Key: needsDateOrderRaw.r2Key,
            fileType:
              typeof needsDateOrderRaw.fileType === 'string' ? needsDateOrderRaw.fileType : '',
            rowCount: asFiniteNumber(needsDateOrderRaw.rowCount),
            samples: asStringList(needsDateOrderRaw.samples),
            defaultCurrency:
              typeof needsDateOrderRaw.defaultCurrency === 'string'
                ? needsDateOrderRaw.defaultCurrency
                : undefined,
          }
        : null,
  };
}

// ── manual-holdings-create ──────────────────────────────────────────────────

interface ManualHoldingRow {
  id: string;
  symbol: string;
  name: string;
  typeCode: string;
  balance: string;
  isUpdate: boolean;
  /** An update kept as a check rather than as the balance: the holding has a
   *  feed, and `balance` is the feed's figure (A5 D-20). */
  savedAsCheck: boolean;
  /** In the reader's base currency despite the producer's field name, which
   *  says USD (`manual-holdings-create.ts` prices against `baseCurrencySymbol`). */
  price: string | null;
  priceSource: string | null;
  /** `null` when there is no price to multiply. Never `0`: a holding whose
   *  price could not be resolved is not a holding worth nothing, and this file
   *  is the last place in the app still printing the zero (SC-185). */
  value: number | null;
  pricingFailed: boolean;
}

export interface ManualHoldingsView {
  accountId: string;
  rows: ManualHoldingRow[];
  pricedCount: number;
  unpricedCount: number;
}

export function readManualHoldings(result: unknown): ManualHoldingsView | null {
  const record = asRecord(result);
  if (typeof record.accountId !== 'string' || !Array.isArray(record.holdings)) return null;

  const rows = record.holdings.map((entry): ManualHoldingRow => {
    const holding = asRecord(entry);
    const price = typeof holding.priceUsd === 'string' ? holding.priceUsd : null;
    const balance = typeof holding.balance === 'string' ? holding.balance : '';
    const pricingFailed = typeof holding.error === 'string' && holding.error.length > 0;
    const numericPrice = Number(price);
    const numericBalance = Number(balance);
    const typedBalance = typeof holding.typedBalance === 'string' ? holding.typedBalance : '';
    const priceable =
      price !== null &&
      !pricingFailed &&
      Number.isFinite(numericPrice) &&
      Number.isFinite(numericBalance);
    return {
      id: typeof holding.id === 'string' ? holding.id : '',
      symbol: typeof holding.symbol === 'string' ? holding.symbol : '',
      name: typeof holding.name === 'string' ? holding.name : '',
      typeCode: typeof holding.typeCode === 'string' ? holding.typeCode : '',
      balance,
      isUpdate: holding.isUpdate === true,
      savedAsCheck:
        holding.isUpdate === true &&
        balance !== '' &&
        typedBalance !== '' &&
        Number.isFinite(numericBalance) &&
        Number.isFinite(Number(typedBalance)) &&
        savedAsCheck(typedBalance, balance),
      price,
      priceSource: typeof holding.priceSource === 'string' ? holding.priceSource : null,
      value: priceable ? numericBalance * numericPrice : null,
      pricingFailed,
    };
  });

  return {
    accountId: record.accountId,
    rows,
    pricedCount: rows.filter((row) => row.value !== null).length,
    unpricedCount: rows.filter((row) => row.value === null).length,
  };
}

// ── budget app imports (SC-1649) ─────────────────────────────────────────────

interface BudgetAppAccountLine {
  name: string;
  accountId: string | null;
  created: boolean;
  rowsInserted: number;
  rowsUpdated: number;
}

export interface BudgetAppImportView {
  importId: string;
  /** Accounts that took rows; a skipped one has no account and is left out. */
  accounts: BudgetAppAccountLine[];
  rowsInserted: number;
  transfersPaired: number;
  transfersUnpaired: number;
  skippedRows: number;
}

export function readBudgetAppImport(result: unknown): BudgetAppImportView | null {
  const record = asRecord(result);
  const summary = asRecord(record.summary);
  if (typeof record.importId !== 'string' || !Array.isArray(summary.accounts)) return null;
  const accounts = summary.accounts
    .map((entry): BudgetAppAccountLine => {
      const account = asRecord(entry);
      return {
        name: typeof account.name === 'string' ? account.name : '',
        accountId: typeof account.accountId === 'string' ? account.accountId : null,
        created: account.created === true,
        rowsInserted: asFiniteNumber(account.rowsInserted),
        rowsUpdated: asFiniteNumber(account.rowsUpdated),
      };
    })
    .filter((account) => account.accountId !== null);
  return {
    importId: record.importId,
    accounts,
    rowsInserted: accounts.reduce((n, account) => n + account.rowsInserted, 0),
    transfersPaired: asFiniteNumber(summary.transfersPaired),
    transfersUnpaired: asFiniteNumber(summary.transfersUnpaired),
    skippedRows: Array.isArray(summary.skippedRows)
      ? rowsLost(summary.skippedRows.map((row) => ({ reason: String(asRecord(row).reason) })))
      : 0,
  };
}

export interface BudgetAppUndoView {
  rowsRemoved: number;
  accountsRemoved: number;
  accountsKept: number;
}

export function readBudgetAppUndo(result: unknown): BudgetAppUndoView | null {
  const record = asRecord(result);
  if (typeof record.rowsRemoved !== 'number') return null;
  return {
    rowsRemoved: asFiniteNumber(record.rowsRemoved),
    accountsRemoved: asFiniteNumber(record.accountsRemoved),
    accountsKept: asFiniteNumber(record.accountsKept),
  };
}

// ── the fallback ────────────────────────────────────────────────────────────

export interface GenericJobView {
  /** The worker's own sentence, when it wrote one. English, and left alone:
   *  it is produced server-side per job and there is no key to translate it
   *  under — the same reason `describeQueryError` cannot translate a provider's
   *  message. */
  message: string | null;
  /** Machine field names, rendered as machine field names. v2 turns
   *  `accountsCreated` into "Accounts Created" with a regex, which manufactures
   *  English for a payload nobody has read — untranslatable, and a label that
   *  looks authored when it is not. */
  stats: Array<{ key: string; value: number }>;
  errors: string[];
  /**
   * What the run wants to tell the reader that is not a failure.
   *
   * The fallback renderer read `errors` and nothing else, so a
   * `transaction-import` — which has no renderer of its own — put every
   * warning it produced into the raw-JSON `<details>` and nowhere a person
   * looks (SC-428). Those warnings are the only place an import says why the
   * history it just wrote is short.
   */
  warnings: JobLine[];
  isEmpty: boolean;
}

export function readGenericJobResult(result: unknown): GenericJobView | null {
  if (result === null || result === undefined) return null;
  const record = asRecord(result);
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.summary === 'string'
        ? record.summary
        : null;
  const stats = Object.entries(record)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => ({ key, value: value as number }));
  const errors = readErrorLines(record.errors);
  const warnings = readJobLines(record);
  return {
    message,
    stats,
    errors,
    warnings,
    isEmpty: message === null && stats.length === 0 && errors.length === 0 && warnings.length === 0,
  };
}
