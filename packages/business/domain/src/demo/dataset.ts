/**
 * The demo dataset builder — pure, no database, no clock, no randomness that
 * is not seeded (SC-465).
 *
 * `buildDemoDataset()` turns the persona in `./persona.ts` into every row the
 * product needs to have something to show, and it does it in one pass so the
 * rows cannot disagree with each other. That single-pass property is the whole
 * design, and it is a reaction to how the earlier one-off seeds failed: they
 * wrote balances, prices and a `portfolio_value_daily` cache from three
 * separate loops, and the cache then said things the ledger underneath it did
 * not (SC-82, SC-107).
 *
 * So here **the ledger is the only source of truth**:
 *
 *   balance(holding, day) = sum of every transaction quantity up to that day
 *   value(holding, day)   = balance x price(token, day) converted to the base
 *   cost(holding, day)    = the pooled cost of what is still held
 *
 * `holdings.balance`, the balance observations and every rollup row are read
 * off those three functions rather than authored. Re-running the real
 * `RollupPortfolioValueDailyUseCase` over this data therefore recomputes
 * roughly what the seed already wrote, instead of contradicting it.
 *
 * Everything returned references tokens by SYMBOL and institutions by NAME.
 * Those two catalogs are shared with every other user in the database and are
 * looked up rather than created, so the builder cannot know their ids — see
 * `DemoDatasetSeeder`.
 */

import type { HoldingTransactionKind } from '@scani/db/schema';
import type { AnswerSource, CostBasisMethodDto, TransferReviewDecision } from '@scani/shared';
import {
  addDays,
  addMonths,
  atHour,
  createRng,
  daysBetween,
  demoUuid,
  isoDay,
  parseDay,
  seededWalk,
} from './deterministic';
import {
  type AccountSpec,
  DEMO_ACCOUNTS,
  DEMO_ANCHOR_DATE,
  DEMO_ASSETS,
  DEMO_BASE_CURRENCY,
  DEMO_BASE_QUOTED_FOREX,
  DEMO_COST_BASIS_METHOD,
  DEMO_FOREX,
  DEMO_GROUPS,
  DEMO_HISTORY_DAYS,
  DEMO_HOLDINGS,
  DEMO_INSTITUTIONS,
  DEMO_PAYMENTS,
  DEMO_TIMEZONE,
  DEMO_USER_EMAIL,
  DEMO_USER_NAME,
  DEMO_VAULTS,
  DEMO_VENDORS,
  type HoldingSpec,
  type InstitutionSpec,
  type PaymentSpec,
} from './persona';

// ===========================================================================
// The shape the seeder consumes
// ===========================================================================

export interface DemoTokenRow {
  readonly symbol: string;
  readonly name: string;
  readonly typeCode: 'crypto' | 'stock';
  readonly decimals: number;
  readonly marketSegment: string | null;
}

export interface DemoPriceRow {
  readonly symbol: string;
  readonly baseSymbol: string;
  readonly at: Date;
  readonly price: string;
}

export interface DemoAccountRow {
  readonly id: string;
  readonly key: string;
  readonly institution: string;
  readonly name: string;
  readonly typeCode: string;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface DemoHoldingRow {
  readonly id: string;
  readonly key: string;
  readonly accountKey: string;
  readonly symbol: string;
  readonly balance: string;
  readonly source: string;
  readonly arrival: string;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly lastUpdated: Date;
  readonly firstTxAt: Date;
  readonly lastTxAt: Date;
  readonly txSources: readonly string[];
}

export interface DemoTransactionRow {
  readonly id: string;
  readonly holdingKey: string;
  readonly symbol: string;
  readonly kind: HoldingTransactionKind;
  readonly quantity: string;
  readonly priceNative: string | null;
  readonly priceNativeSymbol: string | null;
  readonly occurredAt: Date;
  readonly externalId: string;
  readonly source: string;
  readonly swapGroupId: string | null;
  readonly transferGroupId: string | null;
  readonly transferReview: TransferReviewDecision | null;
  readonly transferReviewedAt: Date | null;
  readonly transferReviewSource: AnswerSource | null;
  readonly counterparty: string | null;
  readonly description: string | null;
}

export interface DemoObservationRow {
  readonly id: string;
  readonly holdingKey: string;
  readonly balance: string;
  readonly observedAt: Date;
  readonly source: string;
}

export type DemoScopeKind = 'user' | 'institution' | 'account' | 'holding';

export interface DemoRollupRow {
  readonly scopeKind: DemoScopeKind;
  /** Holding key, account key, institution NAME, or `'user'`. */
  readonly scopeRef: string;
  readonly snapshotDate: string;
  readonly totalValue: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly unrealizedPnl: string;
  readonly coverageQuality: string;
  readonly holdingsWithKnownValue: number;
  readonly holdingsTotal: number;
  readonly transfersUnreviewed: number;
  readonly computedAt: Date;
}

export interface DemoVendorRow {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly category: string;
  readonly website: string;
  readonly aliases: readonly string[];
}

export interface DemoPaymentRow {
  readonly id: string;
  readonly key: string;
  readonly vendorKey: string;
  readonly direction: string;
  readonly kind: string;
  readonly expectedAmount: string;
  readonly currency: string;
  readonly intervalUnit: string;
  readonly intervalCount: number;
  readonly anchorDate: string;
  readonly accountKey: string;
  readonly notes: string | null;
  readonly createdAt: Date;
}

export interface DemoOccurrenceRow {
  readonly id: string;
  readonly paymentKey: string;
  readonly dueDate: string;
  readonly expectedAmount: string;
  readonly actualAmount: string | null;
  readonly status: 'scheduled' | 'matched' | 'missed' | 'skipped';
  /** The ledger row this occurrence was settled by, when there is one. */
  readonly transactionId: string | null;
}

export interface DemoDocumentRow {
  readonly id: string;
  readonly purpose: string;
  readonly r2Key: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly originalFilename: string;
  readonly sourceKind: string;
  readonly classification: string;
  readonly classificationConfidence: string;
  readonly createdAt: Date;
}

export interface DemoExtractionRow {
  readonly id: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly vendorKey: string;
  readonly vendorNameRaw: string;
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly totalAmount: string;
  readonly currencyCode: string;
  readonly lineItems: ReadonlyArray<{ description: string; amount: string }>;
  readonly confidence: string;
  readonly paymentStatus: 'paid' | 'unpaid';
  readonly billingPeriod: string;
  readonly reviewState: 'pending' | 'accepted' | 'rejected';
  readonly createdAt: Date;
}

export interface DemoGroupRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly displayOrder: number;
  readonly holdingKeys: readonly string[];
  readonly accountKeys: readonly string[];
}

export interface DemoVaultRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly targetAmount: string;
  readonly currentAmount: string;
  readonly color: string;
  readonly iconName: string;
  readonly allocations: ReadonlyArray<{ holdingKey: string; percentage: number }>;
}

export interface DemoWalletRow {
  readonly id: string;
  readonly walletAddress: string;
  readonly institution: string;
  readonly label: string;
}

export interface DemoApyRow {
  readonly holdingKey: string;
  readonly annualRatePct: string;
  readonly payoutFrequency: string;
  readonly payoutDayOfMonth: number;
  readonly lastPayoutAt: Date;
}

export interface DemoDataset {
  readonly anchorDate: string;
  readonly startDate: string;
  readonly days: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly baseCurrency: string;
    readonly costBasisMethod: CostBasisMethodDto;
    readonly timezone: string;
    readonly createdAt: Date;
  };
  readonly tokens: readonly DemoTokenRow[];
  readonly institutions: readonly InstitutionSpec[];
  readonly prices: readonly DemoPriceRow[];
  readonly accounts: readonly DemoAccountRow[];
  readonly holdings: readonly DemoHoldingRow[];
  readonly transactions: readonly DemoTransactionRow[];
  readonly observations: readonly DemoObservationRow[];
  readonly rollups: readonly DemoRollupRow[];
  readonly groups: readonly DemoGroupRow[];
  readonly vaults: readonly DemoVaultRow[];
  readonly vendors: readonly DemoVendorRow[];
  readonly payments: readonly DemoPaymentRow[];
  readonly occurrences: readonly DemoOccurrenceRow[];
  readonly documents: readonly DemoDocumentRow[];
  readonly extractions: readonly DemoExtractionRow[];
  readonly wallets: readonly DemoWalletRow[];
  readonly apyConfigs: readonly DemoApyRow[];
}

export interface BuildDemoDatasetOptions {
  /** Last day the dataset covers. Defaults to `DEMO_ANCHOR_DATE`. */
  readonly anchorDate?: string;
  /** Length of the window, inclusive. Defaults to `DEMO_HISTORY_DAYS`. */
  readonly days?: number;
}

// ===========================================================================
// Small helpers
// ===========================================================================

/** Decimal places a quantity of each token is rounded to. */
const QUANTITY_DECIMALS: Record<string, number> = {
  GBP: 2,
  EUR: 2,
  USD: 2,
  VOO: 4,
  AAPL: 4,
  MSFT: 4,
  NVDA: 4,
  BTC: 8,
  ETH: 8,
  SOL: 6,
  USDC: 6,
};

function quantity(symbol: string, value: number): string {
  return value.toFixed(QUANTITY_DECIMALS[symbol] ?? 8);
}

function money(value: number): string {
  return value.toFixed(2);
}

/** Rounds a quantity to the precision it will be stored at, so the running
 *  balance and the stored rows agree to the digit. */
function roundQuantity(symbol: string, value: number): number {
  return Number(quantity(symbol, value));
}

/**
 * The collision key vendor matching uses. Kept in step with
 * `normalizeVendorName` in `../lib/vendor-name` — this is the same
 * lowercase-and-collapse, applied to nine invented names.
 */
function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Day-of-month `dom` in the month `offset` months after `from`'s month. */
function monthDay(from: string, offset: number, dom: number): string {
  const base = parseDay(from);
  const firstOfMonth = isoDay(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)));
  const monthStart = addMonths(firstOfMonth, offset);
  const start = parseDay(monthStart);
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return addDays(monthStart, Math.min(dom, lastDay) - 1);
}

// ===========================================================================
// Prices
// ===========================================================================

interface PriceBook {
  /** USD price of one unit of `symbol` on day index `i`. */
  usd(symbol: string, dayIndex: number): number;
  /** Base-currency (GBP) value of one unit of `symbol` on day index `i`. */
  base(symbol: string, dayIndex: number): number;
  rows: DemoPriceRow[];
}

function buildPriceBook(startDate: string, days: number): PriceBook {
  const usdSeries = new Map<string, number[]>();
  const rows: DemoPriceRow[] = [];

  for (const forex of DEMO_FOREX) {
    const series = seededWalk(['forex', forex.symbol], {
      start: forex.startPrice,
      days,
      totalDrift: forex.totalDrift,
      volatility: forex.volatility,
      reversion: 0.08,
    }).map((value) => Number(value.toFixed(4)));
    usdSeries.set(forex.symbol, series);
  }
  usdSeries.set(
    'USD',
    Array.from({ length: days }, () => 1)
  );

  for (const asset of DEMO_ASSETS) {
    const series = seededWalk(['asset', asset.symbol], {
      start: asset.startPrice,
      days,
      totalDrift: asset.totalDrift,
      volatility: asset.volatility,
    }).map((value) => Number(value.toFixed(asset.priceDecimals)));
    usdSeries.set(asset.symbol, series);
  }

  const usd = (symbol: string, dayIndex: number): number => {
    const series = usdSeries.get(symbol);
    if (!series) throw new Error(`demo dataset: no price series for ${symbol}`);
    return series[Math.max(0, Math.min(dayIndex, series.length - 1))] as number;
  };

  const base = (symbol: string, dayIndex: number): number => {
    if (symbol === DEMO_BASE_CURRENCY) return 1;
    return usd(symbol, dayIndex) / usd(DEMO_BASE_CURRENCY, dayIndex);
  };

  // One `daily` row per priced symbol per day, quoted in USD — the shape
  // `historical-price-backfill` writes, so the pricing services read this the
  // same way they read a real backfill.
  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    const at = atHour(addDays(startDate, dayIndex), 23, 59);
    for (const asset of DEMO_ASSETS) {
      rows.push({
        symbol: asset.symbol,
        baseSymbol: 'USD',
        at,
        price: usd(asset.symbol, dayIndex).toFixed(asset.priceDecimals),
      });
    }
    for (const forex of DEMO_FOREX) {
      rows.push({
        symbol: forex.symbol,
        baseSymbol: 'USD',
        at,
        price: usd(forex.symbol, dayIndex).toFixed(4),
      });
    }
    // The reciprocal leg — see `DEMO_BASE_QUOTED_FOREX`. Derived from the row
    // above rather than walked separately, so the two can never disagree.
    rows.push({
      symbol: DEMO_BASE_QUOTED_FOREX,
      baseSymbol: DEMO_BASE_CURRENCY,
      at,
      price: (1 / usd(DEMO_BASE_CURRENCY, dayIndex)).toFixed(6),
    });
  }

  return { usd, base, rows };
}

// ===========================================================================
// The ledger
// ===========================================================================

interface LedgerEvent {
  readonly holdingKey: string;
  readonly day: string;
  readonly hour: number;
  readonly minute?: number;
  readonly kind: HoldingTransactionKind;
  /** Signed, in token units. */
  readonly delta: number;
  /** Native quote per unit; defaults to the day's USD price. */
  readonly priceNativeSymbol?: string;
  readonly priceNative?: number;
  readonly source: string;
  readonly externalId: string;
  readonly swapGroup?: string;
  readonly transferGroup?: string;
  readonly transferReview?: TransferReviewDecision;
  readonly counterparty?: string;
  readonly description?: string;
}

/** Kinds the review queue asks a question about — `OUTFLOW_KINDS` in
 *  `@scani/shared`, restated here because an event is built before it has an
 *  id and the queue's own predicate needs the answer set on the row. */
const QUEUED_OUTFLOW_KINDS = new Set<HoldingTransactionKind>(['withdraw', 'transfer_out']);

const MONTHS = 18;

interface LedgerContext {
  readonly startDate: string;
  readonly anchorDate: string;
  readonly days: number;
  readonly prices: PriceBook;
  dayIndex(day: string): number;
}

/** The GBP side of a brokerage funding transfer, emitted by the investment
 *  builder and paid by the cash builder so both legs carry one group id. */
interface FundingLeg {
  readonly day: string;
  readonly gbp: number;
  readonly group: string;
}

/** What Ivy keeps in the current account after each month settles. The card
 *  spending below is sized to leave exactly this, which is both how a person
 *  actually behaves and what keeps the balance provably positive. */
const GBP_CARRY_TARGET = 7500;
/** Bounds on that residual, so a fat month cannot produce an absurd figure
 *  and a thin one cannot produce a negative withdrawal. */
const GBP_CARD_MIN = 900;
const GBP_CARD_MAX = 5500;

/** EUR converted to GBP at the start of every month. */
const MONTHLY_EUR_CONVERSION = 12_900;

/**
 * Money moving between Ivy's own accounts, and the bills and retainers that
 * `payment_occurrences` is a schedule of.
 *
 * Each bill occurrence gets its OWN ledger row rather than one aggregated
 * monthly withdrawal, so `payment_occurrences.matched_transaction_id` can
 * point at the row that actually settled it. An occurrence marked `matched`
 * with nothing to point at is the kind of half-truth a demo cannot afford:
 * the Money page would claim a reconciliation that never happened.
 *
 * The month's card spending is a RESIDUAL — whatever is left above
 * `GBP_CARRY_TARGET` once the bills, the brokerage transfer and any quarterly
 * tax sweep have gone out. That is the one figure here nobody would miss being
 * wrong, and making it the balancing item is what stops the current account
 * from ever going overdrawn.
 */
function buildCashFlows(
  ctx: LedgerContext,
  occurrences: readonly DemoOccurrenceRow[],
  funding: readonly FundingLeg[]
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const paymentsByKey = new Map(DEMO_PAYMENTS.map((payment) => [payment.key, payment]));

  for (const [holdingKey, symbol, amount, externalId] of [
    ['wise-eur-cash', 'EUR', 13_500, 'demo-open-wise-eur'],
    ['wise-gbp-cash', 'GBP', 12_000, 'demo-open-wise-gbp'],
    ['revolut-gbp-cash', 'GBP', 9400, 'demo-open-revolut'],
  ] as const) {
    events.push({
      holdingKey,
      day: ctx.startDate,
      hour: 5,
      kind: 'opening_balance',
      delta: amount,
      priceNativeSymbol: symbol,
      priceNative: 1,
      source: 'user-entered',
      externalId,
      description: 'Balance when tracking started',
    });
  }

  for (const occurrence of occurrences) {
    if (occurrence.status !== 'matched') continue;
    const payment = paymentsByKey.get(occurrence.paymentKey) as PaymentSpec;
    const amount = Number(occurrence.actualAmount ?? occurrence.expectedAmount);
    const holdingKey = payment.direction === 'inflow' ? 'wise-eur-cash' : 'wise-gbp-cash';
    const vendor = DEMO_VENDORS.find((entry) => entry.key === payment.vendorKey);
    events.push({
      holdingKey,
      day: occurrence.dueDate,
      hour: payment.direction === 'inflow' ? 10 : 6,
      minute: payment.dayOfMonth % 60,
      kind: payment.direction === 'inflow' ? 'deposit' : 'withdraw',
      delta: payment.direction === 'inflow' ? amount : -amount,
      priceNativeSymbol: payment.currency,
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-bill-${payment.key}-${occurrence.dueDate}`,
      // Every bill is money that genuinely left, and Ivy has said so. Leaving
      // a hundred settled direct debits unanswered would bury the three
      // transfers the queue is actually for.
      transferReview: payment.direction === 'outflow' ? 'left_control' : undefined,
      counterparty: vendor?.displayName,
      description: payment.direction === 'inflow' ? 'Monthly retainer' : undefined,
    });
  }

  // EUR earnings moved to the account the bills come out of, at the start of
  // each month — the previous month's retainers, converted. Paired, so the
  // matcher's job is already done and neither leg reaches the queue.
  for (let month = 0; month < MONTHS; month++) {
    const day = monthDay(ctx.startDate, month, 2);
    if (day < ctx.startDate || day > ctx.anchorDate) continue;
    const gbpAmount = roundQuantity(
      'GBP',
      MONTHLY_EUR_CONVERSION * ctx.prices.base('EUR', ctx.dayIndex(day))
    );
    const group = demoUuid('transfer-group', 'eur-gbp', String(month));
    events.push({
      holdingKey: 'wise-eur-cash',
      day,
      hour: 7,
      kind: 'transfer_out',
      delta: -MONTHLY_EUR_CONVERSION,
      priceNativeSymbol: 'EUR',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-fx-out-${day}`,
      transferGroup: group,
      counterparty: 'Wise GBP',
      description: 'EUR to GBP conversion',
    });
    events.push({
      holdingKey: 'wise-gbp-cash',
      day,
      hour: 7,
      minute: 4,
      kind: 'transfer_in',
      delta: gbpAmount,
      priceNativeSymbol: 'GBP',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-fx-in-${day}`,
      transferGroup: group,
      counterparty: 'Wise EUR',
      description: 'EUR to GBP conversion',
    });
  }

  // The GBP half of every brokerage transfer the investment builder sized.
  for (const leg of funding) {
    events.push({
      holdingKey: 'wise-gbp-cash',
      day: leg.day,
      hour: 11,
      kind: 'transfer_out',
      delta: -leg.gbp,
      priceNativeSymbol: 'GBP',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-ibkr-fund-out-${leg.day}`,
      transferGroup: leg.group,
      counterparty: 'Interactive Brokers',
      description: 'Brokerage funding',
    });
  }

  // Quarterly sweep into the corporation-tax reserve.
  for (let month = 2; month < MONTHS; month += 3) {
    const day = monthDay(ctx.startDate, month, 22);
    if (day > ctx.anchorDate) continue;
    const group = demoUuid('transfer-group', 'tax-reserve', String(month));
    events.push({
      holdingKey: 'wise-gbp-cash',
      day,
      hour: 9,
      kind: 'transfer_out',
      delta: -4500,
      priceNativeSymbol: 'GBP',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-reserve-out-${day}`,
      transferGroup: group,
      counterparty: 'Revolut Savings',
      description: 'Quarterly tax set-aside',
    });
    events.push({
      holdingKey: 'revolut-gbp-cash',
      day,
      hour: 9,
      minute: 6,
      kind: 'transfer_in',
      delta: 4500,
      priceNativeSymbol: 'GBP',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-reserve-in-${day}`,
      transferGroup: group,
      counterparty: 'Wise GBP',
      description: 'Quarterly tax set-aside',
    });
  }

  // Interest on the reserve. The balance it is charged on is a closed form of
  // the sweeps above rather than a second running total that could drift away
  // from them.
  for (let month = 1; month < MONTHS; month++) {
    const day = monthDay(ctx.startDate, month, 28);
    if (day > ctx.anchorDate) continue;
    const sweepsSoFar = Math.max(0, Math.floor((month - 2) / 3) + 1);
    const reserveBalance = 9400 + 4500 * sweepsSoFar;
    events.push({
      holdingKey: 'revolut-gbp-cash',
      day,
      hour: 4,
      kind: 'interest',
      delta: roundQuantity('GBP', (reserveBalance * 0.041) / 12),
      priceNativeSymbol: 'GBP',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-interest-${day}`,
      description: 'Monthly interest',
    });
  }

  // TWO OF THE THREE UNANSWERED OUTFLOWS. The third is the crypto withdrawal
  // in `buildInvestmentFlows`; between them the queue holds a payment to a
  // person, a move to an institution Scani cannot see, and a chain withdrawal
  // with no matching deposit — three different reasons the answer matters.
  events.push({
    holdingKey: 'wise-eur-cash',
    day: monthDay(ctx.startDate, 16, 21),
    hour: 13,
    kind: 'withdraw',
    delta: -2450,
    priceNativeSymbol: 'EUR',
    priceNative: 1,
    source: 'statement-csv',
    externalId: 'demo-unanswered-eur',
    counterparty: 'L. Vasseur',
    description: 'Subcontracted design work',
  });
  events.push({
    holdingKey: 'wise-gbp-cash',
    day: monthDay(ctx.startDate, 17, 24),
    hour: 15,
    kind: 'withdraw',
    delta: -1200,
    priceNativeSymbol: 'GBP',
    priceNative: 1,
    source: 'statement-csv',
    externalId: 'demo-unanswered-gbp',
    counterparty: 'MONZO BANK',
  });

  // Card spending last, because it is what is left. Walking the account's own
  // events in date order is the only way to know that.
  const currentAccount = events
    .filter((event) => event.holdingKey === 'wise-gbp-cash')
    .sort((a, b) => (a.day === b.day ? a.hour - b.hour : a.day < b.day ? -1 : 1));
  let balance = 0;
  let cursor = 0;
  for (let month = 0; month < MONTHS; month++) {
    const day = monthDay(ctx.startDate, month, 27);
    if (day < ctx.startDate || day > ctx.anchorDate) continue;
    while (cursor < currentAccount.length && (currentAccount[cursor] as LedgerEvent).day <= day) {
      balance += (currentAccount[cursor] as LedgerEvent).delta;
      cursor++;
    }
    const spent = roundQuantity(
      'GBP',
      Math.min(GBP_CARD_MAX, Math.max(GBP_CARD_MIN, balance - GBP_CARRY_TARGET))
    );
    balance -= spent;
    events.push({
      holdingKey: 'wise-gbp-cash',
      day,
      hour: 20,
      kind: 'withdraw',
      delta: -spent,
      priceNativeSymbol: 'GBP',
      priceNative: 1,
      source: 'statement-csv',
      externalId: `demo-card-spend-${day}`,
      transferReview: 'left_control',
      counterparty: 'Card spending and cash',
      description: 'Groceries, travel, everything uncategorised',
    });
  }

  return events;
}

/**
 * The brokerage and the crypto side: what the returns engine, the cost-basis
 * pool and the tax-year statement are computed over.
 *
 * Three things here are deliberate rather than incidental:
 *
 * - **Every equity purchase has a USD cash leg** sharing a `swap_group_id`.
 *   Without it the brokerage cash balance drifts away from the positions it
 *   bought, and "where did the money go" is the first question the accounts
 *   page invites.
 * - **The funding is DERIVED from the trades**, not a figure picked to look
 *   plausible next to them. A hand-chosen monthly transfer put the brokerage
 *   cash balance at -$19,757 on the first big purchase, which draws a
 *   net-worth chart that dips below zero — the single most obviously fake
 *   thing a portfolio can do, and invisible until the rows are summed.
 * - **A disposal and a repurchase 13 days apart** (NVDA, month 13). Under FIFO
 *   that is unremarkable; under HMRC's rules it is the bed-and-breakfast case
 *   the 30-day rule exists for, and SC-462 shipped the pooling that gets it
 *   right. A demo aimed at a UK taxpayer should contain the case that
 *   distinguishes the two.
 */
function buildInvestmentFlows(ctx: LedgerContext): {
  events: LedgerEvent[];
  funding: FundingLeg[];
} {
  const events: LedgerEvent[] = [];

  interface Trade {
    holdingKey: string;
    symbol: string;
    day: string;
    units: number;
    label: string;
  }

  const trades: Trade[] = [];
  const push = (holdingKey: string, symbol: string, day: string, units: number, label: string) => {
    if (day <= ctx.anchorDate) trades.push({ holdingKey, symbol, day, units, label });
  };

  push('ibkr-voo', 'VOO', monthDay(ctx.startDate, 1, 7), 8, 'Initial position');
  for (let month = 2; month < MONTHS; month++) {
    push('ibkr-voo', 'VOO', monthDay(ctx.startDate, month, 7), 3, 'Monthly contribution');
  }
  push('ibkr-nvda', 'NVDA', monthDay(ctx.startDate, 3, 11), 70, 'Initial position');
  push('ibkr-aapl', 'AAPL', monthDay(ctx.startDate, 4, 9), 28, 'Initial position');
  push('ibkr-msft', 'MSFT', monthDay(ctx.startDate, 5, 9), 14, 'Initial position');
  // Deliberately in the PREVIOUS UK tax year (6 April - 5 April) to the three
  // disposals below it, so a tax-year statement has two years to separate.
  push('ibkr-nvda', 'NVDA', monthDay(ctx.startDate, 6, 12), -15, 'Partial disposal');
  push('ibkr-aapl', 'AAPL', monthDay(ctx.startDate, 7, 9), 18, 'Top-up');
  push('ibkr-nvda', 'NVDA', monthDay(ctx.startDate, 8, 11), 45, 'Top-up');
  push('ibkr-msft', 'MSFT', monthDay(ctx.startDate, 9, 14), 9, 'Top-up');
  push('ibkr-aapl', 'AAPL', monthDay(ctx.startDate, 12, 17), -20, 'Trimmed position');
  push('ibkr-nvda', 'NVDA', monthDay(ctx.startDate, 13, 5), -40, 'Partial disposal');
  push('ibkr-nvda', 'NVDA', monthDay(ctx.startDate, 13, 18), 20, 'Repurchase within 30 days');
  push('ibkr-nvda', 'NVDA', monthDay(ctx.startDate, 16, 4), -30, 'Partial disposal');

  const cashOf = (trade: Trade): number =>
    roundQuantity(
      'USD',
      Math.abs(trade.units) * ctx.prices.usd(trade.symbol, ctx.dayIndex(trade.day))
    );

  for (const trade of trades) {
    const group = demoUuid('swap-group', trade.holdingKey, trade.day, trade.label);
    const cash = cashOf(trade);
    events.push({
      holdingKey: trade.holdingKey,
      day: trade.day,
      hour: 14,
      minute: 30,
      kind: trade.units > 0 ? 'buy' : 'sell',
      delta: trade.units,
      priceNativeSymbol: 'USD',
      priceNative: ctx.prices.usd(trade.symbol, ctx.dayIndex(trade.day)),
      source: 'user-entered',
      externalId: `demo-trade-${trade.holdingKey}-${trade.day}-${trade.label}`,
      swapGroup: group,
      description: trade.label,
    });
    events.push({
      holdingKey: 'ibkr-usd-cash',
      day: trade.day,
      hour: 14,
      minute: 31,
      kind: trade.units > 0 ? 'swap_out' : 'swap_in',
      delta: trade.units > 0 ? -cash : cash,
      priceNativeSymbol: 'USD',
      priceNative: 1,
      source: 'user-entered',
      externalId: `demo-trade-cash-${trade.holdingKey}-${trade.day}-${trade.label}`,
      swapGroup: group,
      description: `${trade.units > 0 ? 'Bought' : 'Sold'} ${trade.symbol}`,
    });
  }

  // What each month's trading actually costs, settled on the 4th — before the
  // earliest trade day in the calendar above, so the cash is there when the
  // order fills. `MONTHLY_BROKERAGE_FLOAT` is the only free number: it is what
  // accumulates as idle cash over the window.
  const MONTHLY_BROKERAGE_FLOAT = 250;
  const funding: FundingLeg[] = [];
  for (let month = 0; month < MONTHS; month++) {
    const day = monthDay(ctx.startDate, month, 4);
    if (day < ctx.startDate || day > ctx.anchorDate) continue;
    const net = trades
      .filter(
        (trade) =>
          monthDay(ctx.startDate, month, 1) <= trade.day &&
          trade.day < monthDay(ctx.startDate, month + 1, 1)
      )
      .reduce((sum, trade) => sum + (trade.units > 0 ? cashOf(trade) : -cashOf(trade)), 0);
    const usd = roundQuantity('USD', Math.max(0, net) + MONTHLY_BROKERAGE_FLOAT);
    const dayIndex = ctx.dayIndex(day);
    const gbp = roundQuantity('GBP', usd * ctx.prices.base('USD', dayIndex));
    const group = demoUuid('transfer-group', 'ibkr-fund', day);
    funding.push({ day, gbp, group });
    events.push({
      holdingKey: 'ibkr-usd-cash',
      day,
      hour: 11,
      minute: 8,
      kind: 'deposit',
      delta: usd,
      priceNativeSymbol: 'USD',
      priceNative: 1,
      source: 'user-entered',
      externalId: `demo-ibkr-fund-in-${day}`,
      transferGroup: group,
      counterparty: 'Wise GBP',
      description: 'Brokerage funding',
    });
  }

  const acquire = (
    holdingKey: string,
    symbol: string,
    day: string,
    units: number,
    kind: HoldingTransactionKind,
    label: string,
    counterparty?: string
  ): void => {
    if (day > ctx.anchorDate) return;
    events.push({
      holdingKey,
      day,
      hour: 12,
      kind,
      delta: units,
      priceNativeSymbol: 'USD',
      priceNative: ctx.prices.usd(symbol, ctx.dayIndex(day)),
      source: kind === 'reward' ? 'helius' : 'kraken-api',
      externalId: `demo-${kind}-${holdingKey}-${day}`,
      description: label,
      counterparty,
    });
  };

  acquire('kraken-btc', 'BTC', monthDay(ctx.startDate, 0, 19), 0.42, 'buy', 'Initial position');
  acquire('kraken-eth', 'ETH', monthDay(ctx.startDate, 0, 19), 5.5, 'buy', 'Initial position');
  for (let month = 1; month < MONTHS; month++) {
    acquire('kraken-btc', 'BTC', monthDay(ctx.startDate, month, 19), 0.015, 'buy', 'Monthly buy');
    acquire('kraken-eth', 'ETH', monthDay(ctx.startDate, month, 19), 0.35, 'buy', 'Monthly buy');
  }
  acquire('kraken-usdc', 'USDC', monthDay(ctx.startDate, 6, 24), 6000, 'buy', 'Stable reserve');

  // Self-custody moves. `transferGroup` on both legs is what a run of
  // `LinkTransferPairsUseCase` would have produced — minus the one below them.
  const move = (
    fromKey: string,
    toKey: string,
    symbol: string,
    day: string,
    sent: number,
    received: number,
    label: string
  ): void => {
    if (day > ctx.anchorDate) return;
    const price = ctx.prices.usd(symbol, ctx.dayIndex(day));
    const group = demoUuid('transfer-group', fromKey, toKey, day);
    events.push({
      holdingKey: fromKey,
      day,
      hour: 16,
      kind: 'withdraw',
      delta: -sent,
      priceNativeSymbol: 'USD',
      priceNative: price,
      source: 'kraken-api',
      externalId: `demo-move-out-${fromKey}-${day}`,
      transferGroup: group,
      counterparty: label,
      description: 'Withdrawal to self-custody',
    });
    events.push({
      holdingKey: toKey,
      day,
      hour: 16,
      minute: 22,
      kind: 'transfer_in',
      delta: received,
      priceNativeSymbol: 'USD',
      priceNative: price,
      source: 'etherscan',
      externalId: `demo-move-in-${toKey}-${day}`,
      transferGroup: group,
      counterparty: 'Kraken',
      description: 'Received from exchange',
    });
  };

  move(
    'kraken-btc',
    'btc-wallet-btc',
    'BTC',
    monthDay(ctx.startDate, 4, 13),
    0.3,
    0.2994,
    'Ledger'
  );
  move('kraken-eth', 'eth-wallet-eth', 'ETH', monthDay(ctx.startDate, 8, 13), 6, 5.994, 'Ledger');
  move(
    'kraken-usdc',
    'eth-wallet-usdc',
    'USDC',
    monthDay(ctx.startDate, 10, 13),
    2500,
    2499,
    'Ledger'
  );

  // THE THIRD UNANSWERED ONE — a crypto withdrawal with no matching deposit
  // anywhere Scani can see, which is the exact case SC-150's queue exists for
  // and the one where the answer changes a realized-gain figure.
  const orphanDay = monthDay(ctx.startDate, 14, 26);
  events.push({
    holdingKey: 'kraken-btc',
    day: orphanDay,
    hour: 17,
    kind: 'withdraw',
    delta: -0.22,
    priceNativeSymbol: 'USD',
    priceNative: ctx.prices.usd('BTC', ctx.dayIndex(orphanDay)),
    source: 'kraken-api',
    externalId: `demo-move-out-orphan-${orphanDay}`,
    counterparty: 'bc1q...8f2a',
    description: 'Withdrawal, destination unrecorded',
  });

  // Bitcoin bought before the exchange account existed, and Solana staked.
  acquire(
    'btc-wallet-btc',
    'BTC',
    addDays(ctx.startDate, 20),
    0.15,
    'deposit',
    'Bought peer-to-peer'
  );
  acquire('sol-wallet-sol', 'SOL', addDays(ctx.startDate, 25), 140, 'deposit', 'Bought and staked');
  for (let month = 1; month < MONTHS; month++) {
    acquire(
      'sol-wallet-sol',
      'SOL',
      monthDay(ctx.startDate, month, 3),
      1.35,
      'reward',
      'Staking reward'
    );
  }

  return { events, funding };
}

// ===========================================================================
// Payments
// ===========================================================================

function paymentAnchor(spec: PaymentSpec, startDate: string): string {
  if (spec.intervalUnit === 'year') {
    const start = parseDay(startDate);
    const month = (spec.month ?? 1) - 1;
    const year = month >= start.getUTCMonth() ? start.getUTCFullYear() : start.getUTCFullYear() + 1;
    return isoDay(new Date(Date.UTC(year, month, spec.dayOfMonth)));
  }
  return monthDay(startDate, 0, spec.dayOfMonth);
}

function monthsPerInterval(spec: PaymentSpec): number {
  switch (spec.intervalUnit) {
    case 'month':
      return spec.intervalCount;
    case 'quarter':
      return spec.intervalCount * 3;
    case 'year':
      return spec.intervalCount * 12;
    default:
      return spec.intervalCount;
  }
}

/**
 * Occurrences from the start of the window to 120 days past the anchor.
 *
 * Anything due before the anchor is `matched` — never `scheduled`. A schedule
 * whose past is still "scheduled" renders as overdue, and Money then opens on
 * "Overdue, 14 bills" over a portfolio that is perfectly healthy (SC-82). The
 * future side stays `scheduled`, which is what the Upcoming block is for.
 */
function buildOccurrences(startDate: string, anchorDate: string): DemoOccurrenceRow[] {
  const rows: DemoOccurrenceRow[] = [];
  const horizon = addDays(anchorDate, 120);

  for (const spec of DEMO_PAYMENTS) {
    const anchor = paymentAnchor(spec, startDate);
    const step = monthsPerInterval(spec);
    const rng = createRng('occurrence', spec.key);
    const expected = Number(spec.expectedAmount);
    for (let index = 0; ; index++) {
      const dueDate =
        spec.intervalUnit === 'week'
          ? addDays(anchor, index * 7 * spec.intervalCount)
          : monthDay(anchor, index * step, spec.dayOfMonth);
      if (dueDate > horizon) break;
      if (dueDate < startDate) continue;
      const past = dueDate <= anchorDate;
      const varied = spec.variance
        ? Number((expected * (1 + (rng() * 2 - 1) * spec.variance)).toFixed(2))
        : expected;
      rows.push({
        id: demoUuid('occurrence', spec.key, dueDate),
        paymentKey: spec.key,
        dueDate,
        expectedAmount: money(expected),
        actualAmount: past ? money(varied) : null,
        status: past ? 'matched' : 'scheduled',
        transactionId: null,
      });
    }
  }
  return rows;
}

// ===========================================================================
// The build
// ===========================================================================

export function buildDemoDataset(options: BuildDemoDatasetOptions = {}): DemoDataset {
  const anchorDate = options.anchorDate ?? DEMO_ANCHOR_DATE;
  const days = options.days ?? DEMO_HISTORY_DAYS;
  const startDate = addDays(anchorDate, -(days - 1));
  const prices = buildPriceBook(startDate, days);
  const dayIndex = (day: string): number =>
    Math.max(0, Math.min(daysBetween(startDate, day), days - 1));
  const ctx: LedgerContext = { startDate, anchorDate, days, prices, dayIndex };

  const userId = demoUuid('user', DEMO_USER_EMAIL);
  const createdAt = atHour(startDate, 6);

  const occurrences = buildOccurrences(startDate, anchorDate);
  const investment = buildInvestmentFlows(ctx);
  const events = [
    ...buildCashFlows(ctx, occurrences, investment.funding),
    ...investment.events,
  ].sort((a, b) =>
    a.day === b.day
      ? a.hour * 60 + (a.minute ?? 0) - (b.hour * 60 + (b.minute ?? 0))
      : a.day < b.day
        ? -1
        : 1
  );

  const holdingSpecs = new Map<string, HoldingSpec>(DEMO_HOLDINGS.map((h) => [h.key, h]));

  // ---- transactions -------------------------------------------------------
  const transactions: DemoTransactionRow[] = events.map((event) => {
    const spec = holdingSpecs.get(event.holdingKey);
    if (!spec) throw new Error(`demo dataset: unknown holding key ${event.holdingKey}`);
    const answered = event.transferReview ?? null;
    return {
      id: demoUuid('transaction', event.holdingKey, event.externalId),
      holdingKey: event.holdingKey,
      symbol: spec.symbol,
      kind: event.kind,
      quantity: quantity(spec.symbol, event.delta),
      priceNative:
        event.priceNative === undefined
          ? null
          : event.priceNative.toFixed(event.priceNative < 10 ? 6 : 2),
      priceNativeSymbol: event.priceNativeSymbol ?? null,
      occurredAt: atHour(event.day, event.hour, event.minute ?? 0),
      externalId: event.externalId,
      source: event.source,
      swapGroupId: event.swapGroup ?? null,
      transferGroupId: event.transferGroup ?? null,
      transferReview: answered,
      transferReviewedAt: answered ? atHour(addDays(event.day, 2), 19) : null,
      transferReviewSource: answered ? 'user' : null,
      counterparty: event.counterparty ?? null,
      description: event.description ?? null,
    };
  });

  const transactionByExternalId = new Map(transactions.map((t) => [t.externalId, t.id]));

  // Point each settled occurrence at the ledger row that settled it.
  const linkedOccurrences: DemoOccurrenceRow[] = occurrences.map((occurrence) => ({
    ...occurrence,
    transactionId:
      transactionByExternalId.get(`demo-bill-${occurrence.paymentKey}-${occurrence.dueDate}`) ??
      null,
  }));

  // ---- balances, cost basis, realized -------------------------------------
  interface HoldingSeries {
    readonly balance: number[];
    readonly cost: number[];
    readonly realized: number[];
    readonly unreviewed: number[];
    firstIndex: number;
    lastIndex: number;
    readonly sources: Set<string>;
  }

  const series = new Map<string, HoldingSeries>();
  for (const spec of DEMO_HOLDINGS) {
    series.set(spec.key, {
      balance: new Array<number>(days).fill(0),
      cost: new Array<number>(days).fill(0),
      realized: new Array<number>(days).fill(0),
      unreviewed: new Array<number>(days).fill(0),
      firstIndex: -1,
      lastIndex: 0,
      sources: new Set<string>(),
    });
  }

  // ONE GLOBAL PASS, not one pass per holding, and the reason is cost basis.
  //
  // When coins move from Kraken to a Ledger, the cost that left the exchange
  // is the cost that ARRIVES in the wallet — `CostBasisService.walkComponent`
  // walks transfer-linked holdings on a shared lot ledger for exactly this
  // reason. Re-basing the arriving units at that day's market price instead
  // would understate the gain by everything the coins had already made, and
  // measured against this seed it did: 132,932 of cost basis from the real
  // engine against 125,799 from a per-holding walk, on the same ledger.
  //
  // So an outflow carrying a `transferGroup` parks its cost under that id and
  // the matching inflow takes it back.
  const carriedCost = new Map<string, number>();

  const state = (key: string): HoldingSeries => series.get(key) as HoldingSeries;
  const balances = new Map<string, number>();
  const pooled = new Map<string, number>();
  const realizedByHolding = new Map<string, number>();
  const unreviewedByHolding = new Map<string, number>();
  for (const spec of DEMO_HOLDINGS) {
    balances.set(spec.key, 0);
    pooled.set(spec.key, 0);
    realizedByHolding.set(spec.key, 0);
    unreviewedByHolding.set(spec.key, 0);
  }

  let eventCursor = 0;
  for (let index = 0; index < days; index++) {
    const day = addDays(startDate, index);
    while (eventCursor < events.length && (events[eventCursor] as LedgerEvent).day <= day) {
      const event = events[eventCursor] as LedgerEvent;
      eventCursor++;
      const spec = holdingSpecs.get(event.holdingKey) as HoldingSpec;
      const holdingState = state(event.holdingKey);
      holdingState.sources.add(event.source);
      if (holdingState.firstIndex < 0) holdingState.firstIndex = index;
      holdingState.lastIndex = index;

      const unitBase =
        event.priceNativeSymbol && event.priceNative !== undefined
          ? event.priceNative * prices.base(event.priceNativeSymbol, index)
          : prices.base(spec.symbol, index);
      const balance = balances.get(event.holdingKey) as number;
      const cost = pooled.get(event.holdingKey) as number;

      if (event.delta >= 0) {
        const carried = event.transferGroup ? carriedCost.get(event.transferGroup) : undefined;
        if (carried !== undefined) carriedCost.delete(event.transferGroup as string);
        balances.set(event.holdingKey, roundQuantity(spec.symbol, balance + event.delta));
        pooled.set(event.holdingKey, cost + (carried ?? event.delta * unitBase));
      } else {
        const disposed = Math.min(-event.delta, balance);
        const costOut = balance > 0 ? (cost * disposed) / balance : 0;
        // SC-150: a gain is booked when a person has said the units left, and
        // on a sale. Not on a paired transfer, and not on an outflow nobody
        // has answered — `transfersUnreviewed` below is the count that says
        // how much of the realized figure is therefore still missing.
        if (event.kind === 'sell' || event.transferReview === 'left_control') {
          realizedByHolding.set(
            event.holdingKey,
            (realizedByHolding.get(event.holdingKey) as number) + (disposed * unitBase - costOut)
          );
        }
        if (event.transferGroup) carriedCost.set(event.transferGroup, costOut);
        balances.set(event.holdingKey, roundQuantity(spec.symbol, balance + event.delta));
        pooled.set(event.holdingKey, cost - costOut);
        if (QUEUED_OUTFLOW_KINDS.has(event.kind) && !event.transferGroup && !event.transferReview) {
          unreviewedByHolding.set(
            event.holdingKey,
            (unreviewedByHolding.get(event.holdingKey) as number) + 1
          );
        }
      }
    }
    for (const spec of DEMO_HOLDINGS) {
      const holdingState = state(spec.key);
      holdingState.balance[index] = balances.get(spec.key) as number;
      holdingState.cost[index] = pooled.get(spec.key) as number;
      holdingState.realized[index] = realizedByHolding.get(spec.key) as number;
      holdingState.unreviewed[index] = unreviewedByHolding.get(spec.key) as number;
    }
  }

  // ---- holdings -----------------------------------------------------------
  const holdings: DemoHoldingRow[] = DEMO_HOLDINGS.map((spec) => {
    const state = series.get(spec.key) as HoldingSeries;
    const first = Math.max(state.firstIndex, 0);
    return {
      id: demoUuid('holding', spec.key),
      key: spec.key,
      accountKey: spec.accountKey,
      symbol: spec.symbol,
      balance: quantity(spec.symbol, state.balance[days - 1] as number),
      source: spec.source,
      arrival: spec.arrival,
      label: spec.label ?? null,
      createdAt: atHour(addDays(startDate, first), 6),
      lastUpdated: atHour(anchorDate, 23, 45),
      firstTxAt: atHour(addDays(startDate, first), 6),
      lastTxAt: atHour(addDays(startDate, state.lastIndex), 20),
      txSources: [...state.sources].sort(),
    };
  });

  // ---- observations -------------------------------------------------------
  // One `sync-capture` per holding per month plus one at the anchor, which is
  // what an hourly sync leaves behind after 18 months of running — enough for
  // `BalanceAtTimeService` to anchor on rather than extrapolate across the
  // whole window.
  const observations: DemoObservationRow[] = [];
  for (const spec of DEMO_HOLDINGS) {
    const state = series.get(spec.key) as HoldingSeries;
    if (state.firstIndex < 0) continue;
    for (let month = 0; month <= MONTHS; month++) {
      const day = monthDay(startDate, month, 26);
      if (day > anchorDate) break;
      const index = dayIndex(day);
      if (index < state.firstIndex) continue;
      observations.push({
        id: demoUuid('observation', spec.key, day),
        holdingKey: spec.key,
        balance: quantity(spec.symbol, state.balance[index] as number),
        observedAt: atHour(day, 21),
        source: 'sync-capture',
      });
    }
    observations.push({
      id: demoUuid('observation', spec.key, anchorDate, 'close'),
      holdingKey: spec.key,
      balance: quantity(spec.symbol, state.balance[days - 1] as number),
      observedAt: atHour(anchorDate, 23, 40),
      source: 'sync-capture',
    });
  }

  // ---- rollups ------------------------------------------------------------
  const holdingsByAccount = new Map<string, HoldingSpec[]>();
  for (const spec of DEMO_HOLDINGS) {
    const list = holdingsByAccount.get(spec.accountKey) ?? [];
    list.push(spec);
    holdingsByAccount.set(spec.accountKey, list);
  }
  const accountsByInstitution = new Map<string, AccountSpec[]>();
  for (const spec of DEMO_ACCOUNTS) {
    const list = accountsByInstitution.get(spec.institution) ?? [];
    list.push(spec);
    accountsByInstitution.set(spec.institution, list);
  }

  const computedAt = atHour(anchorDate, 4);
  const rollups: DemoRollupRow[] = [];

  const emit = (
    scopeKind: DemoScopeKind,
    scopeRef: string,
    members: readonly HoldingSpec[]
  ): void => {
    for (let index = 0; index < days; index++) {
      const live = members.filter((m) => {
        const state = series.get(m.key) as HoldingSeries;
        return state.firstIndex >= 0 && index >= state.firstIndex;
      });
      if (live.length === 0) continue;
      let value = 0;
      let cost = 0;
      let realized = 0;
      let unreviewed = 0;
      for (const member of live) {
        const state = series.get(member.key) as HoldingSeries;
        value += (state.balance[index] as number) * prices.base(member.symbol, index);
        cost += state.cost[index] as number;
        realized += state.realized[index] as number;
        unreviewed += state.unreviewed[index] as number;
      }
      rollups.push({
        scopeKind,
        scopeRef,
        snapshotDate: addDays(startDate, index),
        totalValue: money(value),
        costBasis: money(cost),
        realizedPnl: money(realized),
        unrealizedPnl: money(value - cost),
        // Every holding is priced from the same seeded series on every day it
        // exists, so there is no partial day in this dataset and claiming one
        // would be inventing a defect.
        coverageQuality: 'full',
        holdingsWithKnownValue: live.length,
        holdingsTotal: live.length,
        transfersUnreviewed: unreviewed,
        computedAt,
      });
    }
  };

  emit('user', 'user', DEMO_HOLDINGS);
  for (const [accountKey, members] of holdingsByAccount) emit('account', accountKey, members);
  for (const [institution, accountList] of accountsByInstitution) {
    emit(
      'institution',
      institution,
      accountList.flatMap((account) => holdingsByAccount.get(account.key) ?? [])
    );
  }
  for (const spec of DEMO_HOLDINGS) emit('holding', spec.key, [spec]);

  // ---- accounts, groups, vaults, wallets ----------------------------------
  const accounts: DemoAccountRow[] = DEMO_ACCOUNTS.map((spec) => ({
    id: demoUuid('account', spec.key),
    key: spec.key,
    institution: spec.institution,
    name: spec.name,
    typeCode: spec.typeCode,
    description: spec.description,
    metadata: spec.walletAddress ? { walletAddress: spec.walletAddress } : {},
    createdAt,
  }));

  const groups: DemoGroupRow[] = DEMO_GROUPS.map((spec, index) => ({
    id: demoUuid('group', spec.key),
    key: spec.key,
    name: spec.name,
    color: spec.color,
    description: spec.description,
    displayOrder: index,
    holdingKeys: spec.holdingKeys,
    // Only an account whose EVERY holding is in the group. A group that
    // claims the whole IBKR account because one cash row is "Liquid" then
    // shows that account's equities under Liquid too, and the same row turns
    // up in two groups that mean opposite things.
    accountKeys: [...holdingsByAccount.entries()]
      .filter(([, members]) => members.every((member) => spec.holdingKeys.includes(member.key)))
      .map(([accountKey]) => accountKey),
  }));

  const finalIndex = days - 1;
  const vaults: DemoVaultRow[] = DEMO_VAULTS.map((spec) => {
    const current = spec.allocations.reduce((sum, allocation) => {
      const holding = holdingSpecs.get(allocation.holdingKey) as HoldingSpec;
      const state = series.get(allocation.holdingKey) as HoldingSeries;
      const value = (state.balance[finalIndex] as number) * prices.base(holding.symbol, finalIndex);
      return sum + (value * allocation.percentage) / 100;
    }, 0);
    return {
      id: demoUuid('vault', spec.key),
      key: spec.key,
      name: spec.name,
      description: spec.description,
      targetAmount: spec.targetAmount,
      currentAmount: money(current),
      color: spec.color,
      iconName: spec.iconName,
      allocations: spec.allocations,
    };
  });

  const wallets: DemoWalletRow[] = DEMO_ACCOUNTS.filter((spec) => spec.walletAddress).map(
    (spec) => ({
      id: demoUuid('wallet', spec.key),
      walletAddress: spec.walletAddress as string,
      institution: spec.institution,
      label: spec.name,
    })
  );

  // ---- vendors, payments --------------------------------------------------
  const vendors: DemoVendorRow[] = DEMO_VENDORS.map((spec) => ({
    id: demoUuid('vendor', spec.key),
    key: spec.key,
    displayName: spec.displayName,
    normalizedName: normalizeVendorName(spec.displayName),
    category: spec.category,
    website: spec.website,
    aliases: [spec.displayName.toUpperCase()],
  }));

  const payments: DemoPaymentRow[] = DEMO_PAYMENTS.map((spec) => ({
    id: demoUuid('payment', spec.key),
    key: spec.key,
    vendorKey: spec.vendorKey,
    direction: spec.direction,
    kind: spec.kind,
    expectedAmount: spec.expectedAmount,
    currency: spec.currency,
    intervalUnit: spec.intervalUnit,
    intervalCount: spec.intervalCount,
    anchorDate: paymentAnchor(spec, startDate),
    accountKey: spec.accountKey,
    notes: spec.notes ?? null,
    createdAt,
  }));

  // ---- documents ----------------------------------------------------------
  const invoiceMonth = monthDay(anchorDate, 0, 3);
  const documents: DemoDocumentRow[] = [
    {
      id: demoUuid('document', 'aws-invoice'),
      purpose: 'invoice',
      r2Key: `demo/${userId}/aws-invoice.pdf`,
      contentHash: demoUuid('content-hash', 'aws-invoice').replace(/-/g, ''),
      mimeType: 'application/pdf',
      byteSize: 48_213,
      originalFilename: 'AWS-Invoice-2027-02.pdf',
      sourceKind: 'upload',
      classification: 'invoice',
      classificationConfidence: '0.97',
      createdAt: atHour(invoiceMonth, 9),
    },
    {
      id: demoUuid('document', 'accountant-invoice'),
      purpose: 'invoice',
      r2Key: `demo/${userId}/thorne-blake-invoice.pdf`,
      contentHash: demoUuid('content-hash', 'accountant-invoice').replace(/-/g, ''),
      mimeType: 'application/pdf',
      byteSize: 31_902,
      originalFilename: 'Thorne-Blake-Q4.pdf',
      sourceKind: 'upload',
      classification: 'invoice',
      classificationConfidence: '0.94',
      createdAt: atHour(addDays(invoiceMonth, -34), 11),
    },
  ];

  const extractions: DemoExtractionRow[] = [
    {
      id: demoUuid('extraction', 'aws-invoice'),
      documentId: (documents[0] as DemoDocumentRow).id,
      ordinal: 0,
      vendorKey: 'aws',
      vendorNameRaw: 'AMAZON WEB SERVICES EMEA SARL',
      invoiceNumber: 'EUINGB27-2891044',
      issueDate: addDays(invoiceMonth, -3),
      dueDate: addDays(invoiceMonth, 11),
      totalAmount: '118.40',
      currencyCode: 'GBP',
      lineItems: [
        { description: 'Amazon Elastic Compute Cloud', amount: '71.20' },
        { description: 'Amazon Simple Storage Service', amount: '28.65' },
        { description: 'AWS Backup', amount: '18.55' },
      ],
      confidence: '0.93',
      paymentStatus: 'unpaid',
      billingPeriod: 'month',
      // THE ONE THING THE REVIEW QUEUE IS ASKED TO CONFIRM from the documents
      // side. `/review` reads `document_extractions.review_state = 'pending'`
      // directly, so a demo where every extraction is already accepted shows
      // an empty queue and never explains what the queue is for.
      reviewState: 'pending',
      createdAt: atHour(invoiceMonth, 9, 4),
    },
    {
      id: demoUuid('extraction', 'accountant-invoice'),
      documentId: (documents[1] as DemoDocumentRow).id,
      ordinal: 0,
      vendorKey: 'thorne-blake',
      vendorNameRaw: 'Thorne & Blake Accountants LLP',
      invoiceNumber: 'TB-2027-0114',
      issueDate: addDays(invoiceMonth, -37),
      dueDate: addDays(invoiceMonth, -23),
      totalAmount: '300.00',
      currencyCode: 'GBP',
      lineItems: [
        { description: 'Quarterly management accounts', amount: '180.00' },
        { description: 'VAT return', amount: '120.00' },
      ],
      confidence: '0.96',
      paymentStatus: 'paid',
      billingPeriod: 'quarter',
      reviewState: 'accepted',
      createdAt: atHour(addDays(invoiceMonth, -34), 11, 6),
    },
  ];

  const apyConfigs: DemoApyRow[] = [
    {
      holdingKey: 'revolut-gbp-cash',
      annualRatePct: '4.1',
      payoutFrequency: 'monthly',
      payoutDayOfMonth: 28,
      lastPayoutAt: atHour(
        monthDay(anchorDate, 0, 28) > anchorDate
          ? monthDay(anchorDate, -1, 28)
          : monthDay(anchorDate, 0, 28),
        4
      ),
    },
  ];

  const tokens: DemoTokenRow[] = DEMO_ASSETS.map((asset) => ({
    symbol: asset.symbol,
    name: asset.name,
    typeCode: asset.typeCode,
    decimals: asset.decimals,
    marketSegment: asset.marketSegment,
  }));

  return {
    anchorDate,
    startDate,
    days,
    user: {
      id: userId,
      email: DEMO_USER_EMAIL,
      name: DEMO_USER_NAME,
      baseCurrency: DEMO_BASE_CURRENCY,
      costBasisMethod: DEMO_COST_BASIS_METHOD,
      timezone: DEMO_TIMEZONE,
      createdAt,
    },
    tokens,
    institutions: DEMO_INSTITUTIONS,
    prices: prices.rows,
    accounts,
    holdings,
    transactions,
    observations,
    rollups,
    groups,
    vaults,
    vendors,
    payments,
    occurrences: linkedOccurrences,
    documents,
    extractions,
    wallets,
    apyConfigs,
  };
}
