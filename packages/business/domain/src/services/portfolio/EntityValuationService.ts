import { UNASSIGNED_ENTITY } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { EntityRepository } from '../../repositories/EntityRepository';
import { BaseService } from '../BaseService';
import {
  PortfolioValuationService,
  type PortfolioValueResult,
  type RequestCache,
} from './PortfolioValuationService';

/**
 * Re-exported, never redefined. The literal lives in `@scani/shared` because
 * the client also has to tell "not in any set of books" from an entity id, and
 * two copies of the one string that carries that distinction is exactly the
 * drift this codebase keeps paying for.
 */
export { UNASSIGNED_ENTITY };

export interface EntityValue {
  /** An entity's id, or the literal `'unassigned'`. */
  entityId: string;
  /** Base-currency total of everything in this set of books we could price. */
  value: string;
  /** How many holdings that total is made of — the figure's coverage. */
  holdingsCounted: number;
  /**
   * Token symbols inside this boundary we could not price. Reported rather
   * than folded in or dropped, for the same reason `GroupValuationService`
   * reports them: an unpriceable position is unknown, not zero.
   */
  unpricedSymbols: string[];
}

export interface EntityValuationResult {
  baseCurrency: string;
  /**
   * Net worth across every boundary — the combined view.
   *
   * This is `PortfolioValuationService`'s own `totalValue`, passed through
   * untouched, NOT a sum computed here. So the combined figure on the entities
   * screen is the same number as the home screen's headline by identity rather
   * than by two derivations agreeing, and `sum(entities) + unassigned` equals
   * it exactly — see the class doc for why that equality is arithmetic here
   * and could not be for groups.
   */
  totalValue: string;
  entities: EntityValue[];
  unassigned: EntityValue;
}

/**
 * What each set of books is worth (SC-463).
 *
 * **The invariant this service exists to hold:**
 *
 *     sum(entities) + unassigned === totalValue
 *
 * exactly, at every moment, with no rounding slack. Get it wrong in one
 * direction and the per-entity totals double-count; in the other the combined
 * view under-reports. Both are silent, which is why the equality is arranged
 * to be arithmetic rather than asserted.
 *
 * **Three decisions make it arithmetic, and none is incidental.**
 *
 * 1. **One derivation of every number.** This service does not price anything.
 *    It buckets `PortfolioValuationService`'s already-computed per-holding
 *    `value` strings and adds them with the same `Decimal`. The combined total
 *    is that service's `totalValue`, untouched. There is no second valuation
 *    to disagree with the first — the SC-385 failure, where one figure had two
 *    resolutions and they differed by 6,185 USD on production for weeks.
 *
 * 2. **It buckets by ACCOUNT, and the partition is total.**
 *    `holdings.account_id` is `NOT NULL` and an account holds exactly one
 *    `entity_id` or none, so every priced holding lands in exactly one bucket.
 *    `unassigned` is a real bucket that is always returned, so an account
 *    nobody has classified is visible rather than absorbed into a boundary its
 *    owner did not put it in.
 *
 * 3. **It reuses the total's own inclusion rule for free.**
 *    `PortfolioValuationService` filters hidden holdings and scam tokens in
 *    the query itself and excludes inactive ones from `totalValue`, so over
 *    `portfolioValue.holdings` the whole of `isIncludedInTotal` reduces to
 *    `isActive`. Applying that one flag here reproduces the total's population
 *    exactly rather than approximating it with a second copy of the contract.
 *
 * **Why this is not shaped like `GroupValuationService`.** That service sums
 * `balance × price` off a price map, and it has to: groups overlap, so there
 * is no total to partition and a holding is deliberately counted in full in
 * every group claiming it. It cannot make this guarantee and does not try —
 * `AssetAllocationService` calls the group cut "the one dimension whose
 * buckets overlap". The price map is also a round trip: `extractPriceMap`
 * divides `value / balance` and the caller multiplies back, which is fine for
 * a figure that stands alone and is not fine for one that has to add up to
 * another number to the cent. Using the `value` strings directly is what makes
 * the invariant exact instead of close.
 *
 * **Not tax output.** SC-90 stays parked — see
 * `docs/technical/2026-08-14_why-no-tax-statement.md`. This separates the
 * books; it does not file anything, and nothing here may acquire a tax
 * framing.
 */
@Service()
export class EntityValuationService extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly entityRepository = Container.get(EntityRepository);

  constructor() {
    super('EntityValuationService');
  }

  async execute(
    userId: string,
    userBaseCurrencyId?: string,
    requestCache?: RequestCache
  ): Promise<EntityValuationResult> {
    const [portfolioValue, entities, accountEntity] = await Promise.all([
      this.portfolioService.getUserPortfolioValue(
        userId,
        userBaseCurrencyId,
        undefined,
        requestCache
      ),
      this.entityRepository.findByUser(userId),
      this.entityRepository.findAccountEntityMap(userId),
    ]);

    const { entities: buckets, unassigned } = this.valueByEntity(
      entities.map((entity) => entity.id),
      portfolioValue,
      accountEntity
    );

    return {
      baseCurrency: portfolioValue.baseCurrency,
      totalValue: portfolioValue.totalValue,
      entities: buckets,
      unassigned,
    };
  }

  /**
   * Bucket an already-computed valuation by ownership boundary.
   *
   * Separated from the fetching so it can be exercised against literal inputs
   * — the invariant this service is about is arithmetic, and arithmetic should
   * be checkable without a database.
   *
   * `entityIds` is passed in rather than derived from the accounts, so an
   * entity holding nothing still returns a zero row. An empty set of books is
   * a fact about the portfolio; omitting it would make "the company has
   * nothing in it yet" render identically to "there is no company".
   */
  valueByEntity(
    entityIds: string[],
    portfolioValue: PortfolioValueResult,
    accountEntity: ReadonlyMap<string, string | null>
  ): { entities: EntityValue[]; unassigned: EntityValue } {
    const totals = new Map<string, Decimal>();
    const counts = new Map<string, number>();
    const unpriced = new Map<string, Set<string>>();

    for (const key of [...entityIds, UNASSIGNED_ENTITY]) {
      totals.set(key, new Decimal(0));
      counts.set(key, 0);
      unpriced.set(key, new Set<string>());
    }

    for (const holding of portfolioValue.holdings) {
      // The whole of `isIncludedInTotal` over this array — hidden holdings and
      // scam tokens never reach it, they are filtered in the query that built
      // it. Excluding inactive here is what keeps these buckets summing to
      // `totalValue`, which excludes them too.
      if (!holding.isActive) continue;

      // An account whose entity was deleted, or one created between the two
      // reads, is unassigned rather than dropped. A holding that reached no
      // bucket would be missing from the parts while still inside the whole,
      // which is the under-reporting half of this service's failure mode.
      const entityId = accountEntity.get(holding.accountId) ?? null;
      const key = entityId !== null && totals.has(entityId) ? entityId : UNASSIGNED_ENTITY;

      if (holding.value === null) {
        // Unpriceable: named beside the boundary's total, never folded into
        // it. A zero balance needs no price and is not a gap in the figure.
        if (new Decimal(holding.balance).isZero()) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
        } else {
          unpriced.get(key)?.add(holding.tokenSymbol);
        }
        continue;
      }

      totals.set(key, (totals.get(key) ?? new Decimal(0)).add(new Decimal(holding.value)));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const read = (key: string): EntityValue => ({
      entityId: key,
      value: (totals.get(key) ?? new Decimal(0)).toString(),
      holdingsCounted: counts.get(key) ?? 0,
      unpricedSymbols: [...(unpriced.get(key) ?? [])].sort(),
    });

    return {
      entities: entityIds.map(read),
      unassigned: read(UNASSIGNED_ENTITY),
    };
  }
}
