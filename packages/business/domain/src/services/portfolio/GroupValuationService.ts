import type { Group } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { extractPriceMap } from '../../lib/price-map';
import { getOrComputeFromCache } from '../../lib/request-cache';
import { GroupRepository } from '../../repositories/GroupRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import { PortfolioValuationService, type RequestCache } from './PortfolioValuationService';

/** The shape this service needs off a holding; anything wider satisfies it. */
export type ValuableHolding = {
  holding: { id: string; accountId: string; balance: string; isActive: boolean };
  token: { symbol: string };
};

export interface GroupValue {
  /** A group's id, or the literal `'ungrouped'` for the leftover bucket. */
  groupId: string;
  /** Base-currency total of everything in the group we could price. */
  value: string;
  /** How many active holdings that total is made of — the figure's coverage. */
  holdingsCounted: number;
  /**
   * Token symbols in the group we could not price today. Reported rather than
   * folded in or dropped: an unpriceable position is unknown, not zero, and a
   * total that silently omits it understates the group.
   */
  unpricedSymbols: string[];
}

export interface GroupValuationResult {
  baseCurrency: string;
  totalValue: string;
  groups: GroupValue[];
  ungrouped: GroupValue;
}

/**
 * What each group is worth, in the user's base currency.
 *
 * One service rather than a figure re-derived per surface, because three
 * surfaces show this number — the group's page, the groups list, and the home
 * screen's groups block — and a fourth (the allocation cut by group) shows it
 * again as a share. They now all read this.
 *
 * **Membership is counted once per group.** A holding can reach a group two
 * ways: assigned to it directly, or through an account assigned to it — and an
 * account's membership is itself derived (`GroupRepository.recomputeAccountGroups`
 * puts an account in a group iff *every* visible holding in it is). So the two
 * paths overlap by construction, and the union has to be taken per group before
 * anything is summed. The code this replaced took the union across *all* groups
 * with one shared set, which silently zeroed a holding's contribution to every
 * group after the first that claimed it.
 *
 * **Conversion is not done here and must not be.** Every price arrives already
 * expressed in the user's base currency — `PortfolioValuationService` resolves
 * each token against `baseCurrency.symbol` — so a group holding EUR cash, a
 * US-listed stock and a token is one comparable sum, not a list of currencies.
 * Adding an FX step at this layer would be the second rate path SC-60 exists to
 * prevent.
 */
@Service()
export class GroupValuationService extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);

  constructor() {
    super('GroupValuationService');
  }

  async execute(
    userId: string,
    userBaseCurrencyId?: string,
    requestCache?: RequestCache
  ): Promise<GroupValuationResult> {
    // Same cache key the allocation uses, so a batched request that asks for
    // both pays for one holdings fetch and one valuation.
    const [portfolioValue, holdingsWithDetails] = await Promise.all([
      this.portfolioService.getUserPortfolioValue(
        userId,
        userBaseCurrencyId,
        undefined,
        requestCache
      ),
      getOrComputeFromCache(requestCache, `holdings:${userId}:complete`, () =>
        this.holdingRepository.findByUserWithFullDetails(userId)
      ),
    ]);

    const { groups, ungrouped } = await this.valueByGroup(
      userId,
      holdingsWithDetails,
      extractPriceMap(portfolioValue)
    );

    return {
      baseCurrency: portfolioValue.baseCurrency,
      totalValue: portfolioValue.totalValue,
      groups: groups.map((entry) => entry.total),
      ungrouped,
    };
  }

  /**
   * Per-group totals from an already-fetched valuation. Kept separate so the
   * allocation cut by group can reuse the arithmetic instead of repeating it.
   */
  async valueByGroup(
    userId: string,
    holdingsWithDetails: ValuableHolding[],
    priceMap: Map<string, string>
  ): Promise<{ groups: Array<{ group: Group; total: GroupValue }>; ungrouped: GroupValue }> {
    const groups = await this.groupRepository.findByUser(userId);
    const groupIds = groups.map((group) => group.id);
    const [holdingsByGroup, accountsByGroup] = await Promise.all([
      this.groupRepository.getHoldingsByGroupIds(groupIds),
      this.groupRepository.getAccountsByGroupIds(groupIds),
    ]);

    const activeById = new Map<string, ValuableHolding>();
    const activeByAccount = new Map<string, ValuableHolding[]>();
    for (const entry of holdingsWithDetails) {
      if (!entry.holding.isActive) continue;
      activeById.set(entry.holding.id, entry);
      const list = activeByAccount.get(entry.holding.accountId);
      if (list) list.push(entry);
      else activeByAccount.set(entry.holding.accountId, [entry]);
    }

    const inSomeGroup = new Set<string>();
    const valued = groups.map((group) => {
      const members = new Set(holdingsByGroup.get(group.id) ?? []);
      for (const accountId of accountsByGroup.get(group.id) ?? []) {
        for (const entry of activeByAccount.get(accountId) ?? []) members.add(entry.holding.id);
      }
      for (const holdingId of members) inSomeGroup.add(holdingId);
      return { group, total: this.sumMembers(group.id, members, activeById, priceMap) };
    });

    const ungroupedMembers = new Set<string>();
    for (const holdingId of activeById.keys()) {
      if (!inSomeGroup.has(holdingId)) ungroupedMembers.add(holdingId);
    }

    return {
      groups: valued,
      ungrouped: this.sumMembers('ungrouped', ungroupedMembers, activeById, priceMap),
    };
  }

  private sumMembers(
    groupId: string,
    memberIds: ReadonlySet<string>,
    activeById: Map<string, ValuableHolding>,
    priceMap: Map<string, string>
  ): GroupValue {
    let total = new Decimal(0);
    let holdingsCounted = 0;
    const unpriced = new Set<string>();

    for (const holdingId of memberIds) {
      // Absent means hidden, scam-flagged or inactive: excluded from the total
      // everywhere else, so excluded from the coverage count too rather than
      // reported as something we failed to price.
      const member = activeById.get(holdingId);
      if (!member) continue;

      const balance = new Decimal(member.holding.balance);
      const price = priceMap.get(member.token.symbol);
      if (price === undefined) {
        // A zero balance is worth zero in every currency, so it needs no price
        // and is not a gap in the figure.
        if (balance.isZero()) holdingsCounted += 1;
        else unpriced.add(member.token.symbol);
        continue;
      }

      total = total.add(balance.mul(new Decimal(price)));
      holdingsCounted += 1;
    }

    return {
      groupId,
      value: total.toString(),
      holdingsCounted,
      unpricedSymbols: [...unpriced].sort(),
    };
  }
}
