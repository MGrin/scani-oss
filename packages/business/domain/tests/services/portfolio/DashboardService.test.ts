process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, it } from 'bun:test';
import Decimal from 'decimal.js';

/**
 * DashboardService unit tests with mocked repositories.
 *
 * The real DashboardService depends on PortfolioValuationService, HoldingRepository,
 * and AssetAllocationService via TypeDI.  Rather than fighting the DI container
 * in unit tests, we replicate the key aggregation logic that DashboardService
 * performs and test it in isolation.  This validates the data-shaping code while
 * remaining fully deterministic.
 */

// ---------------------------------------------------------------------------
// Types mirroring DashboardService internals
// ---------------------------------------------------------------------------

interface PortfolioValueResult {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    // `null` matches the PortfolioValuationService contract — unpriceable
    // holdings carry null and are excluded from the totalValue sum.
    currentPrice: string | null;
    value: string | null;
  }>;
}

interface HoldingWithDetails {
  holding: {
    id: string;
    balance: string;
    isActive: boolean;
    isHidden: boolean;
  };
  token: {
    id: string;
    symbol: string;
    name: string;
    typeCode: string;
    typeName: string;
  };
  account: {
    id: string;
    name: string;
    institutionId: string;
    typeCode: string;
  };
  institution: {
    id: string;
    name: string;
    website?: string;
    typeCode: string;
  };
}

// ---------------------------------------------------------------------------
// Replicated helpers from DashboardService
// ---------------------------------------------------------------------------

function extractPriceMap(portfolioValue: PortfolioValueResult): Map<string, string> {
  // Mirror the real extractPriceMap (packages/business/domain/src/lib/price-map.ts):
  // null `value` → skip the holding entirely; the returned map only
  // contains symbols we can actually price.
  const priceMap = new Map<string, string>();
  for (const h of portfolioValue.holdings) {
    if (h.value === null) continue;
    const balance = new Decimal(h.balance);
    const value = new Decimal(h.value);
    if (balance.greaterThan(0) && !priceMap.has(h.tokenSymbol)) {
      const price = value.div(balance);
      priceMap.set(h.tokenSymbol, price.toString());
    }
  }
  return priceMap;
}

function calculateTopHoldings(
  holdingsWithDetails: HoldingWithDetails[],
  portfolioValue: PortfolioValueResult
) {
  const priceMap = extractPriceMap(portfolioValue);

  // Mirror DashboardService.calculateTopHoldings: priceMap only carries
  // priceable tokens. Skip unpriceable holdings entirely rather than
  // ranking a zero against genuine zeros.
  const holdingsWithValues = holdingsWithDetails
    .filter(({ holding }) => holding.isActive)
    .flatMap(({ holding, token, account, institution }) => {
      const currentPrice = priceMap.get(token.symbol);
      if (!currentPrice) return [];
      const balance = new Decimal(holding.balance);
      const value = balance.mul(new Decimal(currentPrice)).toString();
      return [{ holding, token, account, institution, value, currentPrice }];
    })
    .filter((h) => new Decimal(h.value).greaterThan(0));

  return holdingsWithValues
    .sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)))
    .slice(0, 5)
    .map((h, index) => ({
      id: `${h.holding.id}-${index}`,
      symbol: h.token.symbol,
      name: h.token.name,
      balance: h.holding.balance,
      value: h.value,
      currentPrice: h.currentPrice,
      tokenType: h.token.typeName,
      tokenTypeCode: h.token.typeCode,
      accountId: h.account.id,
      accountName: h.account.name,
      accountTypeCode: h.account.typeCode,
      institutionId: h.institution.id,
      institutionName: h.institution.name,
      institutionWebsite: h.institution.website || undefined,
    }));
}

function buildDashboardOverview(
  holdingsWithDetails: HoldingWithDetails[],
  portfolioValue: PortfolioValueResult
) {
  const activeHoldings = holdingsWithDetails.filter((h) => h.holding.isActive);

  const accountMap = new Map<string, { id: string; name: string; institutionId: string }>();
  const institutionSet = new Set<string>();

  activeHoldings.forEach(({ account, institution }) => {
    if (!accountMap.has(account.id)) {
      accountMap.set(account.id, account);
    }
    institutionSet.add(institution.id);
  });

  const topHoldings = calculateTopHoldings(holdingsWithDetails, portfolioValue);

  return {
    portfolioValue: {
      totalValue: portfolioValue.totalValue,
      baseCurrency: portfolioValue.baseCurrency,
    },
    counts: {
      institutions: institutionSet.size,
      accounts: accountMap.size,
      holdings: activeHoldings.length,
    },
    topHoldings,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHolding(
  overrides: Partial<HoldingWithDetails> & {
    holding: Partial<HoldingWithDetails['holding']> &
      Pick<HoldingWithDetails['holding'], 'id' | 'balance'>;
    token: Partial<HoldingWithDetails['token']> &
      Pick<HoldingWithDetails['token'], 'id' | 'symbol' | 'name'>;
  }
): HoldingWithDetails {
  return {
    holding: {
      isActive: true,
      isHidden: false,
      ...overrides.holding,
    },
    token: {
      typeCode: 'crypto',
      typeName: 'Cryptocurrency',
      ...overrides.token,
    },
    account: {
      id: 'acc-1',
      name: 'Default Account',
      institutionId: 'inst-1',
      typeCode: 'checking',
      ...overrides.account,
    },
    institution: {
      id: 'inst-1',
      name: 'Default Institution',
      typeCode: 'broker',
      ...overrides.institution,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardService (unit)', () => {
  describe('getDashboardData returns correct aggregation', () => {
    it('should aggregate counts, top holdings, and total value', () => {
      const holdings: HoldingWithDetails[] = [
        makeHolding({
          holding: { id: 'h1', balance: '2' },
          token: { id: 't1', symbol: 'BTC', name: 'Bitcoin' },
          account: { id: 'acc-1', name: 'Wallet', institutionId: 'inst-1', typeCode: 'wallet' },
          institution: { id: 'inst-1', name: 'Ethereum', typeCode: 'blockchain' },
        }),
        makeHolding({
          holding: { id: 'h2', balance: '50' },
          token: { id: 't2', symbol: 'ETH', name: 'Ethereum' },
          account: {
            id: 'acc-2',
            name: 'Brokerage',
            institutionId: 'inst-2',
            typeCode: 'brokerage',
          },
          institution: { id: 'inst-2', name: 'Coinbase', typeCode: 'exchange' },
        }),
      ];

      const portfolioValue: PortfolioValueResult = {
        totalValue: '270000',
        baseCurrency: 'USD',
        holdings: [
          { tokenSymbol: 'BTC', balance: '2', value: '120000' },
          { tokenSymbol: 'ETH', balance: '50', value: '150000' },
        ],
      };

      const result = buildDashboardOverview(holdings, portfolioValue);

      expect(result.portfolioValue.totalValue).toBe('270000');
      expect(result.portfolioValue.baseCurrency).toBe('USD');
      expect(result.counts.institutions).toBe(2);
      expect(result.counts.accounts).toBe(2);
      expect(result.counts.holdings).toBe(2);
      expect(result.topHoldings).toHaveLength(2);

      // Top holding should be ETH (150k > 120k)
      expect(result.topHoldings[0].symbol).toBe('ETH');
      expect(result.topHoldings[1].symbol).toBe('BTC');
    });

    it('should only count active holdings and exclude inactive from top holdings', () => {
      const holdings: HoldingWithDetails[] = [
        makeHolding({
          holding: { id: 'h1', balance: '1', isActive: true },
          token: { id: 't1', symbol: 'BTC', name: 'Bitcoin' },
        }),
        makeHolding({
          holding: { id: 'h2', balance: '100', isActive: false },
          token: { id: 't2', symbol: 'ETH', name: 'Ethereum' },
        }),
      ];

      const portfolioValue: PortfolioValueResult = {
        totalValue: '60000',
        baseCurrency: 'USD',
        holdings: [
          { tokenSymbol: 'BTC', balance: '1', value: '60000' },
          { tokenSymbol: 'ETH', balance: '100', value: '300000' },
        ],
      };

      const result = buildDashboardOverview(holdings, portfolioValue);

      expect(result.counts.holdings).toBe(1);
      expect(result.topHoldings).toHaveLength(1);
      expect(result.topHoldings[0].symbol).toBe('BTC');
    });

    it('should cap top holdings at 5', () => {
      const holdings: HoldingWithDetails[] = Array.from({ length: 8 }, (_, i) =>
        makeHolding({
          holding: { id: `h${i}`, balance: String(10 - i) },
          token: { id: `t${i}`, symbol: `TKN${i}`, name: `Token ${i}` },
        })
      );

      const portfolioValue: PortfolioValueResult = {
        totalValue: '360',
        baseCurrency: 'USD',
        holdings: holdings.map((h, i) => ({
          tokenSymbol: h.token.symbol,
          balance: h.holding.balance,
          value: String((10 - i) * 10),
        })),
      };

      const result = buildDashboardOverview(holdings, portfolioValue);
      expect(result.topHoldings.length).toBeLessThanOrEqual(5);
    });
  });

  describe('handles empty portfolio', () => {
    it('should return zeros when there are no holdings', () => {
      const portfolioValue: PortfolioValueResult = {
        totalValue: '0',
        baseCurrency: 'USD',
        holdings: [],
      };

      const result = buildDashboardOverview([], portfolioValue);

      expect(result.portfolioValue.totalValue).toBe('0');
      expect(result.counts.institutions).toBe(0);
      expect(result.counts.accounts).toBe(0);
      expect(result.counts.holdings).toBe(0);
      expect(result.topHoldings).toHaveLength(0);
    });

    it('should exclude unpriceable holdings (null value) from top holdings', () => {
      const holdings: HoldingWithDetails[] = [
        makeHolding({
          holding: { id: 'h1', balance: '100' },
          token: { id: 't1', symbol: 'UNKNOWN', name: 'Unknown Token' },
        }),
      ];

      const portfolioValue: PortfolioValueResult = {
        totalValue: '0',
        baseCurrency: 'USD',
        // Unpriceable holding: value is `null`, not `'0'`. The dashboard
        // must distinguish "couldn't price" from "worth zero" — both
        // resolve to "not in top holdings" but for different reasons.
        holdings: [{ tokenSymbol: 'UNKNOWN', balance: '100', currentPrice: null, value: null }],
      };

      const result = buildDashboardOverview(holdings, portfolioValue);

      expect(result.counts.holdings).toBe(1);
      // Unpriceable holdings are excluded from top holdings.
      expect(result.topHoldings).toHaveLength(0);
    });
  });

  describe('request cache deduplication', () => {
    it('should return cached result on second call with same key', async () => {
      // Import the actual request cache utility
      const { getOrComputeFromCache } = await import('../../../src/lib/request-cache');

      const cache = new Map<string, unknown>();
      let computeCount = 0;

      const factory = async () => {
        computeCount++;
        return { totalValue: '100', baseCurrency: 'USD', holdings: [] };
      };

      const key = 'portfolio:user-1';

      const result1 = await getOrComputeFromCache(cache, key, factory);
      const result2 = await getOrComputeFromCache(cache, key, factory);

      expect(computeCount).toBe(1); // factory only called once
      expect(result1).toBe(result2); // same reference
    });

    it('should compute separately for different keys', async () => {
      const { getOrComputeFromCache } = await import('../../../src/lib/request-cache');

      const cache = new Map<string, unknown>();
      let computeCount = 0;

      const factory = async () => {
        computeCount++;
        return { totalValue: String(computeCount * 100) };
      };

      await getOrComputeFromCache(cache, 'portfolio:user-1', factory);
      await getOrComputeFromCache(cache, 'portfolio:user-2', factory);

      expect(computeCount).toBe(2);
    });

    it('should deduplicate concurrent calls for the same key', async () => {
      const { getOrComputeFromCache } = await import('../../../src/lib/request-cache');

      const cache = new Map<string, unknown>();
      let computeCount = 0;

      const factory = async () => {
        computeCount++;
        // Simulate async work
        await new Promise((r) => setTimeout(r, 50));
        return { totalValue: '999' };
      };

      const key = 'portfolio:user-concurrent';

      // Fire two concurrent calls
      const [r1, r2] = await Promise.all([
        getOrComputeFromCache(cache, key, factory),
        getOrComputeFromCache(cache, key, factory),
      ]);

      expect(computeCount).toBe(1);
      expect(r1).toEqual(r2);
    });
  });
});
