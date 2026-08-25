import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { extractPriceMap } from '../../lib/price-map';
import { getOrComputeFromCache } from '../../lib/request-cache';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import {
  PortfolioValuationService,
  type RequestCache,
} from '../portfolio/PortfolioValuationService';

/**
 * What a runway is allowed to be spent from.
 *
 * mgrin's call, 2026-08-26, and it is the BROADEST of the definitions that
 * were on the table: everything counts except what is explicitly illiquid.
 * Listed equities and crypto are in — they can be sold in days — and only
 * property, private positions and anything with no price at all are out.
 *
 * **Which makes naming the denominator part of the feature, not decoration.**
 * A runway of fourteen months computed over equities the owner would never
 * actually sell is a true number answering a question nobody asked, so this
 * returns what it COUNTED and what it SET ASIDE, and the surface prints both
 * beside the figure. A caller that renders `amount` alone is using this
 * wrongly.
 *
 * ## The two exclusions, and the one that does not exist
 *
 * - `private-company` **tokens** — the token type seeded for positions with
 *   no public price. Held at a valuation, not a price.
 * - `real_estate` and `private_equity` **institutions** — the two institution
 *   types whose whole premise is that selling takes months.
 *
 * *Locked staking is not excluded, because this schema cannot see it.* There
 * is no lock, term or unbonding-period column on `holdings` — checked
 * 2026-08-26 — so a staked position is indistinguishable from a liquid one.
 * That is stated here rather than silently approximated: the exclusion list
 * this returns is what was actually excluded, and adding a category it cannot
 * detect would make the caption a lie in the one direction that flatters the
 * number.
 *
 * Falsifier: `grep -c 'lock' packages/infra/db/src/schema/holdings.ts` → 0.
 */

/** Token type codes that are never liquid, whatever they are worth. */
const ILLIQUID_TOKEN_TYPE_CODES = new Set(['private-company']);

/** Institution type codes whose holdings cannot be turned into money quickly. */
const ILLIQUID_INSTITUTION_TYPE_CODES = new Set(['real_estate', 'private_equity']);

export interface LiquidAssets {
  /** Decimal string, in the user's base currency. */
  amount: string;
  baseCurrency: string;
  /** Holdings that make up `amount`. */
  countedHoldings: number;
  /**
   * Set aside as illiquid, with what they came to. Named so the reader can
   * see the figure is a subset and how big a subset it is.
   */
  illiquid: { count: number; amount: string };
  /**
   * Holdings with no resolvable price. They contribute nothing rather than
   * zero — the same rule the dashboard total follows — and are counted so a
   * portfolio that is mostly unpriced does not read as mostly empty.
   */
  unpriceable: { count: number };
}

@Service()
export class LiquidAssetsService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  constructor() {
    super('LiquidAssetsService');
  }

  async getLiquidAssets(
    userId: string,
    baseCurrencyId?: string,
    requestCache?: RequestCache
  ): Promise<LiquidAssets> {
    // The same two reads, under the same request-cache key, that
    // `DashboardService.getDashboardOverview` makes. On the home screen both
    // procedures land in one tRPC batch and this costs nothing; more
    // importantly the liquid figure is then computed from exactly the prices
    // the allocation chart beside it was drawn from, so the two cannot
    // disagree.
    const holdingsCacheKey = `holdings:${userId}:complete`;
    const [portfolioValue, holdingsWithDetails] = await Promise.all([
      this.portfolioValuationService.getUserPortfolioValue(
        userId,
        baseCurrencyId,
        undefined,
        requestCache
      ),
      getOrComputeFromCache(requestCache, holdingsCacheKey, () =>
        this.holdingRepository.findByUserWithFullDetails(userId)
      ),
    ]);

    const priceMap = extractPriceMap(portfolioValue);

    let liquid = new Decimal(0);
    let illiquidValue = new Decimal(0);
    let countedHoldings = 0;
    let illiquidCount = 0;
    let unpriceableCount = 0;

    for (const { holding, token, institution } of holdingsWithDetails) {
      if (!holding.isActive) continue;

      const price = priceMap.get(token.symbol);
      if (!price) {
        unpriceableCount += 1;
        continue;
      }
      const value = new Decimal(holding.balance).mul(new Decimal(price));

      const illiquid =
        ILLIQUID_TOKEN_TYPE_CODES.has(token.typeCode) ||
        ILLIQUID_INSTITUTION_TYPE_CODES.has(institution.typeCode);

      if (illiquid) {
        illiquidCount += 1;
        illiquidValue = illiquidValue.plus(value);
        continue;
      }

      countedHoldings += 1;
      liquid = liquid.plus(value);
    }

    return {
      amount: liquid.toString(),
      baseCurrency: portfolioValue.baseCurrency,
      countedHoldings,
      illiquid: { count: illiquidCount, amount: illiquidValue.toString() },
      unpriceable: { count: unpriceableCount },
    };
  }
}
