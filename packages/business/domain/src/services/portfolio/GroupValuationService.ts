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
 * **Membership is read exactly once, from `findGroupsForHoldings`** — the same
 * call that puts `HoldingWithDetails.groups` on the wire, so the money and the
 * list that opens under it cannot answer "who is in this group" differently.
 * That single resolution is SC-385's fix and it survives SC-386 unchanged;
 * what SC-386 changed is what the resolution ANSWERS.
 *
 * Membership is a standing rule now (mgrin, 2026-08-18): a holding is in a
 * group by its own `holding_groups` row OR because its account is in the group,
 * unless it carries a `holding_group_exclusions` veto. `account_groups` stopped
 * being a cache — it is the rule itself — so the eight rows that were stale on
 * production are true again, and the 6,218.75 USD of Airwallex cash that this
 * service was made to stop counting is counted once more, this time by the
 * holdings list as well. Liquid reads 53,024.05 on both surfaces — where the
 * card alone said 53,024.05 before SC-385, and both said 46,805.30 after it.
 *
 * The reason it is safe to add back is the veto. Six of those wallets receive
 * airdrops continuously; without a per-holding way out, a standing rule would
 * drag every one of them into the group. With one, the remove the user already
 * has takes a single position out and leaves the account where it is.
 *
 * Summing per group off one map also keeps the defect this service was
 * extracted to fix fixed: the code it replaced carried ONE set of already-
 * counted holdings across every group, so a holding claimed by the first group
 * contributed nothing to the second.
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

    const activeById = new Map<string, ValuableHolding>();
    for (const entry of holdingsWithDetails) {
      if (!entry.holding.isActive) continue;
      activeById.set(entry.holding.id, entry);
    }

    const membership = await this.groupRepository.findGroupsForHoldings(
      [...activeById.values()].map(({ holding }) => ({
        id: holding.id,
        accountId: holding.accountId,
      }))
    );

    // `findGroupsForHoldings` joins every group row, `findByUser` only the
    // active ones — so a holding whose only group was deactivated belongs to
    // none of the groups anybody can see, and lands in `ungrouped` rather than
    // vanishing from every bucket.
    const visible = new Set(groups.map((group) => group.id));
    const membersByGroup = new Map<string, Set<string>>();
    const ungroupedMembers = new Set<string>();
    for (const holdingId of activeById.keys()) {
      const memberOf = (membership.get(holdingId) ?? []).filter((group) => visible.has(group.id));
      if (memberOf.length === 0) {
        ungroupedMembers.add(holdingId);
        continue;
      }
      for (const group of memberOf) {
        const members = membersByGroup.get(group.id);
        if (members) members.add(holdingId);
        else membersByGroup.set(group.id, new Set([holdingId]));
      }
    }

    return {
      groups: groups.map((group) => ({
        group,
        total: this.sumMembers(
          group.id,
          membersByGroup.get(group.id) ?? new Set<string>(),
          activeById,
          priceMap
        ),
      })),
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
