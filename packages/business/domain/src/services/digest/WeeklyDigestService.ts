import { formatCurrency } from '@scani/shared';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { PaymentOccurrenceRepository } from '../../repositories/PaymentOccurrenceRepository';
import { PortfolioValueDailyRepository } from '../../repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { TransferReviewService } from '../TransferReviewService';

/** How far back a "since last week" comparison reaches. */
export const DIGEST_WINDOW_DAYS = 7;

/**
 * How stale the newest rollup row may be before the digest refuses to quote it.
 *
 * The rollup runs nightly at 04:00, so on a healthy day the newest row is
 * yesterday's. Eight days is the point past which a whole week's rollups have
 * failed — and a mail that says "your net worth is X" over a figure nobody has
 * recomputed in over a week is a wrong statement, not a stale one.
 */
export const DIGEST_MAX_SNAPSHOT_AGE_DAYS = 8;

/** Bills shown by name before the digest starts counting them instead. */
const MAX_BILLS_LISTED = 3;

/** Movers shown. Three fits a phone without scrolling. */
const MAX_MOVERS = 3;

type Direction = 'up' | 'down' | 'flat';

export interface DigestChange {
  /** Signed, already formatted in the base currency. */
  amount: string;
  /** e.g. `2.1%`. Absent when last week's figure was zero. */
  percent: string | null;
  direction: Direction;
}

export interface DigestMover {
  symbol: string;
  amount: string;
  percent: string | null;
  direction: Direction;
}

export interface DigestBill {
  vendorName: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  /** Formatted, or null for a variable bill with no estimate. */
  amount: string | null;
}

export interface WeeklyDigest {
  /** Net worth, formatted in the user's base currency. */
  netWorth: string;
  /** The snapshot date the figure is FROM — never presented as "now". */
  asOf: string;
  /** Null when there is no comparable snapshot a week back. */
  change: DigestChange | null;
  movers: DigestMover[];
  bills: DigestBill[];
  /** Bills due in the window beyond the ones listed. */
  moreBills: number;
  /** Transfers sitting in the review queue. */
  reviewCount: number;
}

/** Reasons a digest was not built. Each is reported separately — see below. */
export type DigestSkipReason = 'no-snapshot' | 'stale-snapshot' | 'no-holdings';

export type DigestOutcome =
  | { digest: WeeklyDigest; skipped?: undefined }
  | { digest?: undefined; skipped: DigestSkipReason };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`);
  const to = Date.parse(`${toIso}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

function directionOf(delta: number): Direction {
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

function signed(delta: number, currency: string): string {
  const formatted = formatCurrency(Math.abs(delta), currency);
  if (delta > 0) return `+${formatted}`;
  if (delta < 0) return `−${formatted}`;
  return formatted;
}

function percentOf(delta: number, from: number): string | null {
  if (from === 0) return null;
  const pct = (delta / Math.abs(from)) * 100;
  if (!Number.isFinite(pct)) return null;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * Assembles one user's weekly digest out of rows the product already writes.
 *
 * Nothing here computes a valuation. The headline and the movers both come
 * from `portfolio_value_daily`, which the nightly rollup fills at 04:00 — so
 * the digest and the dashboard cannot disagree about what a portfolio is
 * worth, and a Monday morning mail costs a handful of indexed reads rather
 * than a re-valuation of every holding in the userbase.
 *
 * `buildFor` returns a SKIP REASON rather than null when it declines. The
 * three reasons need three different people to do three different things — a
 * user who has connected nothing, a rollup that has stopped running, and a
 * user whose holdings are all hidden or scam-flagged — and a single null makes
 * "nobody was eligible" and "the rollup is broken" the same log line.
 */
@Service()
export class WeeklyDigestService {
  private readonly rollups = Container.get(PortfolioValueDailyRepository);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly tokens = Container.get(TokenRepository);
  private readonly occurrences = Container.get(PaymentOccurrenceRepository);
  private readonly review = Container.get(TransferReviewService);

  async buildFor(
    user: { id: string; baseCurrencyId: string },
    now: Date = new Date()
  ): Promise<DigestOutcome> {
    const baseToken = await this.tokens.findById(user.baseCurrencyId);
    const currency = baseToken?.symbol ?? 'USD';

    // One indexed range read covers both the headline and the comparison.
    // Twice the window so a rollup that missed a night still has a row to
    // compare against rather than silently dropping the whole change line.
    const from = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 2 * 86_400_000);
    const rows = await this.rollups.findRange(user.id, user.baseCurrencyId, from, now);
    const current = rows.at(-1);
    if (!current) return { skipped: 'no-snapshot' };

    const asOf = String(current.snapshotDate);
    if (daysBetween(asOf, isoDate(now)) > DIGEST_MAX_SNAPSHOT_AGE_DAYS) {
      return { skipped: 'stale-snapshot' };
    }

    // The guardrail on SC-460: 8 of 15 accounts would otherwise receive a
    // digest reporting nothing. `holdings_total` counts every holding in
    // scope, so zero here means the account has no portfolio at all.
    if (current.holdingsTotal === 0) return { skipped: 'no-holdings' };

    const currentValue = Number(current.totalValue);
    const baselineDate = shiftDays(asOf, -DIGEST_WINDOW_DAYS);
    // The newest row at or before the baseline: an exact hit on most weeks,
    // the nearest earlier one when a rollup night failed.
    const baseline = rows.filter((r) => String(r.snapshotDate) <= baselineDate).at(-1);

    let change: DigestChange | null = null;
    if (baseline) {
      const delta = currentValue - Number(baseline.totalValue);
      change = {
        amount: signed(delta, currency),
        percent: percentOf(delta, Number(baseline.totalValue)),
        direction: directionOf(delta),
      };
    }

    const [movers, bills, reviewSummary] = await Promise.all([
      this.moversFor(user, asOf, baseline ? String(baseline.snapshotDate) : null, currency),
      this.billsFor(user.id, isoDate(now)),
      this.review.pendingSummary(user.id),
    ]);

    return {
      digest: {
        netWorth: formatCurrency(currentValue, currency),
        asOf,
        change,
        movers,
        bills: bills.slice(0, MAX_BILLS_LISTED),
        moreBills: Math.max(0, bills.length - MAX_BILLS_LISTED),
        reviewCount: reviewSummary.count,
      },
    };
  }

  private async moversFor(
    user: { id: string; baseCurrencyId: string },
    asOf: string,
    baselineDate: string | null,
    currency: string
  ): Promise<DigestMover[]> {
    if (!baselineDate) return [];
    const rows = await this.rollups.findIncludedHoldingScopeRange(
      user.id,
      user.baseCurrencyId,
      new Date(`${baselineDate}T00:00:00.000Z`),
      new Date(`${asOf}T00:00:00.000Z`)
    );

    const deltas = new Map<string, { start: number | null; end: number | null }>();
    for (const row of rows) {
      const date = String(row.snapshotDate);
      const entry = deltas.get(row.holdingId) ?? { start: null, end: null };
      if (date === baselineDate) entry.start = Number(row.totalValue);
      if (date === asOf) entry.end = Number(row.totalValue);
      deltas.set(row.holdingId, entry);
    }

    // A holding present on only one of the two dates is skipped, not treated
    // as a move from zero: an import that landed on Wednesday would otherwise
    // be the week's biggest gainer every time.
    const ranked = [...deltas.entries()]
      .filter(([, v]) => v.start !== null && v.end !== null)
      .map(([holdingId, v]) => ({
        holdingId,
        start: v.start as number,
        delta: (v.end as number) - (v.start as number),
      }))
      .filter((m) => m.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, MAX_MOVERS);
    if (ranked.length === 0) return [];

    const holdings = await this.holdings.findByIds(ranked.map((m) => m.holdingId));
    const tokens = await this.tokens.findByIds([...new Set(holdings.map((h) => h.tokenId))]);
    const symbolByToken = new Map(tokens.map((t) => [t.id, t.symbol]));
    const symbolByHolding = new Map(
      holdings.map((h) => [h.id, symbolByToken.get(h.tokenId) ?? '—'])
    );

    return ranked.map((m) => ({
      symbol: symbolByHolding.get(m.holdingId) ?? '—',
      amount: signed(m.delta, currency),
      percent: percentOf(m.delta, m.start),
      direction: directionOf(m.delta),
    }));
  }

  private async billsFor(userId: string, today: string): Promise<DigestBill[]> {
    const due = await this.occurrences.findDueBetweenForUser(
      userId,
      today,
      shiftDays(today, DIGEST_WINDOW_DAYS)
    );
    return due.map((o) => ({
      vendorName: o.vendorName,
      dueDate: o.dueDate,
      // Formatted in the BILL's currency, not the base — a €1,200 rent
      // converted to dollars is a different number from the one that will
      // leave the account.
      amount: o.expectedAmount === null ? null : formatCurrency(o.expectedAmount, o.currencySymbol),
    }));
  }
}
