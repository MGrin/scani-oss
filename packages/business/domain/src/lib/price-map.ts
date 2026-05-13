import Decimal from 'decimal.js';

interface PriceMapInput {
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    // `null` for unpriceable holdings — those are skipped so the
    // returned map only contains symbols we can actually price.
    value: string | null;
  }>;
}

export function extractPriceMap(portfolioValue: PriceMapInput): Map<string, string> {
  const priceMap = new Map<string, string>();
  for (const portfolioHolding of portfolioValue.holdings) {
    if (portfolioHolding.value === null) continue;
    const balance = new Decimal(portfolioHolding.balance);
    const value = new Decimal(portfolioHolding.value);
    if (balance.greaterThan(0) && !priceMap.has(portfolioHolding.tokenSymbol)) {
      const price = value.div(balance);
      priceMap.set(portfolioHolding.tokenSymbol, price.toString());
    }
  }
  return priceMap;
}
