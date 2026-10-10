export type IncomeGroup = 'dividend' | 'interest' | 'staking' | 'rewards';

/** Base-currency decimals. `net` is `gross` less `withheld`. */
export interface IncomeAmounts {
  gross: string;
  withheld: string;
  net: string;
}

export interface IncomeMonth {
  /** `YYYY-MM`, of the income row's UTC date. */
  month: string;
  groups: Partial<Record<IncomeGroup, IncomeAmounts>>;
}

export interface DividendSource {
  isin: string | null;
  symbol: string | null;
  payments: number;
  amounts: IncomeAmounts;
}

export interface IncomeSummary {
  baseCurrencyId: string;
  window: { from: Date; to: Date };
  /** Ascending, and only months holding at least one valued income row. */
  months: IncomeMonth[];
  totals: Partial<Record<IncomeGroup, IncomeAmounts>>;
  /** Gross descending. */
  dividendsBySecurity: DividendSource[];
  /** Income rows no price could value, left out of every figure above. */
  unpricedCount: number;
  /** Fees naming a paying security (`source_metadata.paidBy`) with no `fee_of`. */
  unmatchedWithholdingCount: number;
}

export type IncomeOutcome =
  | { status: 'ok'; income: IncomeSummary }
  | { status: 'scope-not-found' }
  | { status: 'no-base-currency' };
