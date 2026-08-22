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
  isNew: boolean;
}

export interface FileImportCurrencyPrompt {
  r2Key: string;
  fileType: string;
  transactionCount: number;
  preview: Array<{ date: string; description: string; amount: number }>;
}

export interface FileImportView {
  format: string;
  accountId: string;
  transactionCount: number;
  observationCount: number;
  newHoldingCount: number;
  holdings: FileImportHolding[];
  warnings: string[];
  /** Set when the file carried no usable currency and the parse stopped. */
  needsCurrency: FileImportCurrencyPrompt | null;
}

export function readFileImport(result: unknown): FileImportView | null {
  const record = asRecord(result);
  if (typeof record.accountId !== 'string') return null;
  if (typeof record.transactionCount !== 'number') return null;
  if (!Array.isArray(record.holdingsTouched)) return null;

  const created = new Set(asStringList(record.holdingsCreated));
  const needsCurrencyRaw = asRecord(record.needsCurrency);
  const hasCurrencyPrompt = typeof needsCurrencyRaw.r2Key === 'string';

  return {
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
        isNew: created.has(holdingId),
      };
    }),
    warnings: asStringList(record.warnings),
    needsCurrency: hasCurrencyPrompt
      ? {
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
  warnings: string[];
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
  const warnings = asStringList(record.warnings);
  return {
    message,
    stats,
    errors,
    warnings,
    isEmpty: message === null && stats.length === 0 && errors.length === 0 && warnings.length === 0,
  };
}
