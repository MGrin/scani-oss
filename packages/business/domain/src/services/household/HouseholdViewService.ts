import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { AssetAllocationDimension, AssetAllocationItem } from '@scani/shared';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { aggregateAllocation } from '../../lib/portfolio/allocation';
import { extractPriceMap } from '../../lib/price-map';
import {
  HoldingRepository,
  type HoldingWithFullDetails,
} from '../../repositories/HoldingRepository';
import { PortfolioValueDailyRepository } from '../../repositories/PortfolioValueDailyRepository';
import {
  PortfolioValuationService,
  type PortfolioValueResult,
} from '../portfolio/PortfolioValuationService';
import { PriceReader } from '../pricing/PriceReader';
import { HouseholdAccessService, type VisibleAccount } from './HouseholdAccessService';
import { HouseholdError } from './household-errors';

export interface HouseholdAccountRow {
  accountId: string;
  name: string;
  institutionName: string;
  ownerId: string;
  ownerName: string;
  ownedByViewer: boolean;
  value: string;
}

export interface TrackedTwice {
  accountIds: [string, string];
  reason: 'same-name' | 'same-wallet';
}

export interface HouseholdNow {
  baseCurrencyId: string;
  baseCurrencySymbol: string;
  total: string;
  allocation: AssetAllocationItem[];
  accounts: HouseholdAccountRow[];
  trackedTwice: TrackedTwice[];
}

export interface HouseholdHistory {
  baseCurrencyId: string;
  series: Array<{ date: string; value: string }>;
  /** Days an owner's rows could not be converted: named, never summed short. */
  unmeasuredDates: string[];
}

type AccountFacts = VisibleAccount & {
  name: string;
  institutionId: string;
  institutionName: string;
  walletAddress: string | null;
};

/**
 * What a household sees now (SC-1647): each owner's own valuation, priced in
 * the household currency and narrowed to the accounts they shared. Nothing is
 * cached, so a share withdrawn is gone from the next read.
 */
@Service()
export class HouseholdViewService {
  private readonly access = Container.get(HouseholdAccessService);
  private readonly valuation = Container.get(PortfolioValuationService);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly daily = Container.get(PortfolioValueDailyRepository);
  private readonly prices = Container.get(PriceReader);

  async now(
    viewerId: string,
    dimension: Exclude<AssetAllocationDimension, 'group'>,
    opts: { at?: Date; tx?: DatabaseTransaction } = {}
  ): Promise<HouseholdNow> {
    const at = opts.at ?? new Date();
    const db = opts.tx ?? getDb();
    const membership = await this.access.membershipOf(viewerId, opts.tx);
    if (!membership) throw new HouseholdError('no-household', 'You are not in a household');

    const visible = await this.access.visibleAccounts(viewerId, opts.tx);
    const [currency] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, membership.baseCurrencyId))
      .limit(1);
    const shared = new Set(visible.map((account) => account.accountId));

    const valued: PortfolioValueResult['holdings'] = [];
    const details: HoldingWithFullDetails[] = [];
    let travelling = new Decimal(0);
    for (const ownerId of new Set(visible.map((account) => account.ownerId))) {
      const portfolio = await this.valuation.computePortfolioValueAt(ownerId, {
        at,
        baseCurrencyId: membership.baseCurrencyId,
        tx: opts.tx,
      });
      const rows = await this.holdings.findByUserWithFullDetails(ownerId, undefined, opts.tx);
      valued.push(...portfolio.holdings.filter((holding) => shared.has(holding.accountId)));
      details.push(...rows.filter((row) => shared.has(row.account.id)));
      // Money in transit counts with the account it travels to (SC-1675), so a
      // transfer between two shared accounts never dips the household figure.
      const accountOf = new Map(portfolio.holdings.map((h) => [h.holdingId, h.accountId]));
      for (const line of portfolio.inTransit ?? []) {
        const destination = accountOf.get(line.destinationHoldingId);
        if (line.value === null || destination === undefined || !shared.has(destination)) continue;
        travelling = travelling.add(new Decimal(line.value));
      }
    }

    // The total rule of `computePortfolioValueAt`: hidden and scam holdings
    // never reach `valued`, so active and priced is the rest of it.
    const byAccount = new Map<string, Decimal>();
    for (const holding of valued) {
      if (!holding.isActive || holding.value === null) continue;
      const sum = byAccount.get(holding.accountId) ?? new Decimal(0);
      byAccount.set(holding.accountId, sum.add(new Decimal(holding.value)));
    }
    const total = [...byAccount.values()].reduce((sum, value) => sum.add(value), travelling);

    const facts = await this.accountFacts(visible, opts.tx);
    return {
      baseCurrencyId: membership.baseCurrencyId,
      baseCurrencySymbol: currency?.symbol ?? '',
      total: total.toString(),
      allocation: aggregateAllocation(details, extractPriceMap({ holdings: valued }), dimension)
        .items,
      accounts: facts.map((account) => ({
        accountId: account.accountId,
        name: account.name,
        institutionName: account.institutionName,
        ownerId: account.ownerId,
        ownerName: account.ownerName,
        ownedByViewer: account.ownedByViewer,
        value: (byAccount.get(account.accountId) ?? new Decimal(0)).toString(),
      })),
      trackedTwice: trackedTwice(facts),
    };
  }

  /**
   * The household's daily net worth from stored rollup rows only: no day is
   * recomputed here. Each owner's rows are in their own base, converted at the
   * instant the rollup valued that day.
   */
  async history(
    viewerId: string,
    from: Date,
    to: Date,
    tx?: DatabaseTransaction
  ): Promise<HouseholdHistory> {
    const membership = await this.access.membershipOf(viewerId, tx);
    if (!membership) throw new HouseholdError('no-household', 'You are not in a household');
    const { baseCurrencyId } = membership;
    const visible = await this.access.visibleAccounts(viewerId, tx);
    const owners = [...new Set(visible.map((account) => account.ownerId))];
    if (owners.length === 0) return { baseCurrencyId, series: [], unmeasuredDates: [] };

    const bases = await (tx ?? getDb())
      .select({ id: schema.users.id, baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(inArray(schema.users.id, owners));
    const baseOf = new Map(bases.map((user) => [user.id, user.baseCurrencyId]));
    const today = new Date().toISOString().slice(0, 10);
    const sums = new Map<string, Decimal>();
    const unmeasured = new Set<string>();

    for (const ownerId of owners) {
      const ownerBase = baseOf.get(ownerId);
      // An owner with no base currency has no rollup rows to read.
      if (!ownerBase) continue;
      const days = new Map<string, { value: Decimal; at: Date }>();
      for (const account of visible.filter((row) => row.ownerId === ownerId)) {
        const rows = await this.daily.findRange(ownerId, ownerBase, from, to, tx, {
          kind: 'account',
          id: account.accountId,
        });
        for (const row of rows) {
          const date = String(row.snapshotDate);
          // The rollup values a past day at its last millisecond, today at the run.
          const at = date === today ? row.computedAt : new Date(`${date}T23:59:59.999Z`);
          const day = days.get(date) ?? { value: new Decimal(0), at };
          day.value = day.value.add(new Decimal(row.totalValue));
          days.set(date, day);
        }
      }
      // A day's money in transit is in no account row; it counts with the
      // account it travels to, as it does now (SC-1675).
      const transit = await this.daily.findTransitRange(ownerId, ownerBase, from, to, tx);
      if (transit.length > 0) {
        const sharedHoldings = await this.sharedHoldingIds(
          visible.filter((row) => row.ownerId === ownerId).map((row) => row.accountId),
          tx
        );
        for (const row of transit) {
          const day = days.get(row.snapshotDate);
          if (!day || !sharedHoldings.has(row.holdingId)) continue;
          day.value = day.value.add(new Decimal(row.value));
        }
      }
      let rateAt = (_at: Date): Decimal | null => new Decimal(1);
      if (ownerBase !== baseCurrencyId && days.size > 0) {
        const asks = [...days.values()].map((day) => ({ tokenId: ownerBase, at: day.at }));
        const series = await this.prices.series(asks, baseCurrencyId, tx);
        rateAt = (at) => {
          const reading = series.priceAt(ownerBase, at);
          return reading ? new Decimal(reading.price.toString()) : null;
        };
      }
      for (const [date, day] of days) {
        const rate = rateAt(day.at);
        if (rate === null) {
          unmeasured.add(date);
          continue;
        }
        sums.set(date, (sums.get(date) ?? new Decimal(0)).add(day.value.mul(rate)));
      }
    }

    const dates = [...new Set([...sums.keys(), ...unmeasured])].sort();
    return {
      baseCurrencyId,
      series: dates
        .filter((date) => !unmeasured.has(date))
        .map((date) => ({ date, value: (sums.get(date) ?? new Decimal(0)).toString() })),
      unmeasuredDates: dates.filter((date) => unmeasured.has(date)),
    };
  }

  private async sharedHoldingIds(
    accountIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const rows = await (tx ?? getDb())
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(inArray(schema.holdings.accountId, [...accountIds]));
    return new Set(rows.map((row) => row.id));
  }

  private async accountFacts(
    visible: readonly VisibleAccount[],
    tx?: DatabaseTransaction
  ): Promise<AccountFacts[]> {
    if (visible.length === 0) return [];
    const db = tx ?? getDb();
    const rows = await db
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        institutionId: schema.accounts.institutionId,
        institutionName: schema.institutions.name,
        metadata: schema.accounts.metadata,
      })
      .from(schema.accounts)
      .innerJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
      .where(
        inArray(
          schema.accounts.id,
          visible.map((account) => account.accountId)
        )
      );
    const walletIds = rows.flatMap((row) => {
      const id = (row.metadata as { userWalletId?: unknown }).userWalletId;
      return typeof id === 'string' ? [id] : [];
    });
    const wallets =
      walletIds.length === 0
        ? []
        : await db
            .select({ id: schema.userWallets.id, address: schema.userWallets.walletAddress })
            .from(schema.userWallets)
            .where(inArray(schema.userWallets.id, walletIds));
    const addressOf = new Map(wallets.map((wallet) => [wallet.id, wallet.address.toLowerCase()]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return visible.flatMap((account) => {
      const row = byId.get(account.accountId);
      if (!row) return [];
      const walletId = (row.metadata as { userWalletId?: unknown }).userWalletId;
      return [
        {
          ...account,
          name: row.name,
          institutionId: row.institutionId,
          institutionName: row.institutionName,
          walletAddress: typeof walletId === 'string' ? (addressOf.get(walletId) ?? null) : null,
        },
      ];
    });
  }
}

/**
 * Pairs of accounts under two owners that are probably one account: the
 * household total counts both, and says so rather than guessing which to drop.
 */
function trackedTwice(accounts: readonly AccountFacts[]): TrackedTwice[] {
  const pairs: TrackedTwice[] = [];
  const seen = new Set<string>();
  const add = (group: readonly AccountFacts[], reason: TrackedTwice['reason']) => {
    for (const [i, first] of group.entries()) {
      for (const second of group.slice(i + 1)) {
        const key = [first.accountId, second.accountId].sort().join(':');
        if (first.ownerId === second.ownerId || seen.has(key)) continue;
        seen.add(key);
        pairs.push({ accountIds: [first.accountId, second.accountId], reason });
      }
    }
  };
  for (const group of groupBy(accounts, (a) => `${a.institutionId}:${a.name.toLowerCase()}`)) {
    add(group, 'same-name');
  }
  for (const group of groupBy(accounts, (a) => a.walletAddress)) add(group, 'same-wallet');
  return pairs;
}

function groupBy(
  accounts: readonly AccountFacts[],
  key: (account: AccountFacts) => string | null
): AccountFacts[][] {
  const groups = new Map<string, AccountFacts[]>();
  for (const account of accounts) {
    const value = key(account);
    if (value === null) continue;
    groups.set(value, [...(groups.get(value) ?? []), account]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}
