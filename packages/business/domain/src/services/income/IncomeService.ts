import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { type ReturnWindowRequest, resolveReturnWindow } from '../../lib/returns/window';
import { valuationInstantsOf, valueRowInBase } from '../../lib/tx-valuation';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { PriceReader } from '../pricing/PriceReader';
import { type ReturnsScope, ReturnsScopeResolver } from '../returns/ReturnsScopeResolver';
import type {
  DividendSource,
  IncomeAmounts,
  IncomeGroup,
  IncomeMonth,
  IncomeOutcome,
} from './types';

const GROUP_OF_SUBTYPE: Readonly<Record<string, IncomeGroup>> = {
  dividend: 'dividend',
  interest: 'interest',
  apy: 'interest',
  staking: 'staking',
};

interface PaidBy {
  isin: string | null;
  symbol: string | null;
}

class Tally {
  gross = new Decimal(0);
  withheld = new Decimal(0);

  amounts(): IncomeAmounts {
    return {
      gross: this.gross.toString(),
      withheld: this.withheld.toString(),
      net: this.gross.minus(this.withheld).toString(),
    };
  }
}

/** The security a dividend or its withholding names, written by the provider (SC-1644). */
function paidByOf(tx: HoldingTransaction): PaidBy | null {
  const paidBy = (tx.sourceMetadata as { paidBy?: { isin?: unknown; symbol?: unknown } } | null)
    ?.paidBy;
  if (!paidBy) return null;
  return {
    isin: typeof paidBy.isin === 'string' ? paidBy.isin : null,
    symbol: typeof paidBy.symbol === 'string' ? paidBy.symbol : null,
  };
}

/**
 * Income received over a returns scope and window, per month and group, in
 * the base currency at receipt (D19).
 *
 * Read-only. Withholding is a fee whose `fee_of` is an income row, and counts
 * in that row's month and group rather than its own, because a broker can book
 * the tax on a later statement than the payment it was taken from.
 */
@Service()
export class IncomeService {
  private readonly scopeResolver = Container.get(ReturnsScopeResolver);
  private readonly userRepository = Container.get(UserRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly priceReader = Container.get(PriceReader);

  async compute(request: {
    userId: string;
    scope: ReturnsScope;
    window: ReturnWindowRequest;
    now?: Date;
  }): Promise<IncomeOutcome> {
    const now = request.now ?? new Date();
    const window = resolveReturnWindow(request.window, now);
    const baseCurrencyId = (await this.userRepository.findById(request.userId))?.baseCurrencyId;
    if (!baseCurrencyId) return { status: 'no-base-currency' };
    const holdings = await this.scopeResolver.resolve(request.userId, request.scope);
    if (holdings === null) return { status: 'scope-not-found' };

    const included = await this.holdingRepository.findIdsIncludedInTotal(
      holdings.map((h) => h.holdingId)
    );
    const weights = new Map(
      holdings.filter((h) => included.has(h.holdingId)).map((h) => [h.holdingId, h.weight])
    );
    const holdingIds = [...weights.keys()];
    const [rows, holdingRows] = holdingIds.length
      ? await Promise.all([
          this.txRepository.findForHoldingsInRange(holdingIds, window.from, window.to),
          this.holdingRepository.findByIds(holdingIds),
        ])
      : [[], []];

    const income = rows.filter((tx) => tx.ledgerKind === 'income');
    const incomeIds = new Set(income.map((tx) => tx.id));
    const withholding = rows.filter(
      (tx) => tx.ledgerKind === 'fee' && tx.feeOf !== null && incomeIds.has(tx.feeOf)
    );
    const unmatchedWithholdingCount = rows.filter(
      (tx) => tx.ledgerKind === 'fee' && tx.feeOf === null && paidByOf(tx) !== null
    ).length;

    const heldTokenByHolding = new Map(holdingRows.map((h) => [h.id, h.tokenId]));
    const heldOf = (tx: HoldingTransaction) =>
      heldTokenByHolding.get(tx.holdingId) ?? tx.tokenId ?? null;
    const valued = [...income, ...withholding];
    const prices = await this.priceReader.series(
      valued.flatMap((tx) => valuationInstantsOf(tx, baseCurrencyId, heldOf(tx), now)),
      baseCurrencyId
    );
    // Signed: `valueRowInBase` works on magnitudes, so the ledger's own sign is
    // re-applied here, as the flow side does. A negative income row takes
    // income back and a positive fee on a dividend returns tax.
    const baseValueOf = (tx: HoldingTransaction): Decimal | null => {
      const weight = weights.get(tx.holdingId);
      if (!weight) return null;
      const recorded = new Decimal(tx.quantity);
      const valuation = valueRowInBase(prices, tx, recorded.abs(), baseCurrencyId, heldOf(tx), now);
      if (!valuation) return null;
      const magnitude = new Decimal(valuation.amount.toString()).abs().times(weight);
      return recorded.isNegative() ? magnitude.negated() : magnitude;
    };

    const months = new Map<string, Map<IncomeGroup, Tally>>();
    const totals = new Map<IncomeGroup, Tally>();
    const securities = new Map<string, { paidBy: PaidBy; payments: number; tally: Tally }>();
    const tallyOf = <K>(map: Map<K, Tally>, key: K): Tally => {
      const found = map.get(key);
      if (found) return found;
      const fresh = new Tally();
      map.set(key, fresh);
      return fresh;
    };

    let unpricedCount = 0;
    const placed = new Map<
      string,
      { month: string; group: IncomeGroup; security: string | null }
    >();
    for (const tx of income) {
      const value = baseValueOf(tx);
      if (value === null) {
        unpricedCount += 1;
        continue;
      }
      const month = tx.occurredAt.toISOString().slice(0, 7);
      const group = GROUP_OF_SUBTYPE[tx.kindSubtype ?? ''] ?? 'rewards';
      const monthGroups = months.get(month) ?? new Map<IncomeGroup, Tally>();
      months.set(month, monthGroups);
      tallyOf(monthGroups, group).gross = tallyOf(monthGroups, group).gross.plus(value);
      tallyOf(totals, group).gross = tallyOf(totals, group).gross.plus(value);

      const paidBy = group === 'dividend' ? paidByOf(tx) : null;
      const security = paidBy ? (paidBy.isin ?? paidBy.symbol) : null;
      if (paidBy && security) {
        const entry = securities.get(security) ?? { paidBy, payments: 0, tally: new Tally() };
        entry.payments += 1;
        entry.tally.gross = entry.tally.gross.plus(value);
        securities.set(security, entry);
      }
      placed.set(tx.id, { month, group, security });
    }

    for (const tx of withholding) {
      const target = placed.get(tx.feeOf as string);
      const value = target ? baseValueOf(tx) : null;
      if (!target || value === null) continue;
      const monthTally = tallyOf(months.get(target.month) as Map<IncomeGroup, Tally>, target.group);
      monthTally.withheld = monthTally.withheld.minus(value);
      const total = tallyOf(totals, target.group);
      total.withheld = total.withheld.minus(value);
      const source = target.security ? securities.get(target.security) : undefined;
      if (source) source.tally.withheld = source.tally.withheld.minus(value);
    }

    const groupsOf = (map: Map<IncomeGroup, Tally>) =>
      Object.fromEntries([...map].map(([group, tally]) => [group, tally.amounts()]));
    const monthList: IncomeMonth[] = [...months.keys()]
      .sort()
      .map((month) => ({ month, groups: groupsOf(months.get(month) as Map<IncomeGroup, Tally>) }));
    const dividendsBySecurity: DividendSource[] = [...securities.values()]
      .sort((a, b) => b.tally.gross.comparedTo(a.tally.gross))
      .map(({ paidBy, payments, tally }) => ({
        isin: paidBy.isin,
        symbol: paidBy.symbol,
        payments,
        amounts: tally.amounts(),
      }));

    return {
      status: 'ok',
      income: {
        baseCurrencyId,
        window: { from: window.from, to: window.to },
        months: monthList,
        totals: groupsOf(totals),
        dividendsBySecurity,
        unpricedCount,
        unmatchedWithholdingCount,
      },
    };
  }
}
