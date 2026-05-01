import Decimal from 'decimal.js';

interface PriceMapInput {
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    value?: string;
  }>;
}

export function extractPriceMap(portfolioValue: PriceMapInput): Map<string, string> {
  const priceMap = new Map<string, string>();
  for (const portfolioHolding of portfolioValue.holdings) {
    const balance = new Decimal(portfolioHolding.balance);
    const value = new Decimal(portfolioHolding.value || '0');
    if (balance.greaterThan(0) && !priceMap.has(portfolioHolding.tokenSymbol)) {
      const price = value.div(balance);
      priceMap.set(portfolioHolding.tokenSymbol, price.toString());
    }
  }
  return priceMap;
}
