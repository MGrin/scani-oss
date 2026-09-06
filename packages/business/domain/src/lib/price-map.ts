import Decimal from 'decimal.js';

interface PriceMapInput {
  holdings: Array<{
    tokenId: string;
    balance: string;
    // `null` for unpriceable holdings — those are skipped so the
    // returned map only contains tokens we can actually price.
    value: string | null;
  }>;
}

/**
 * Per-token unit price, derived from each holding's value ÷ balance.
 *
 * Keyed on the TOKEN ID, never the symbol. A symbol is not unique — a
 * `private-company` token and a crypto token can carry the same one — so a
 * symbol-keyed map holds one price for two different assets and every consumer
 * below values both of them at it (SC-1114). Callers must look up with
 * `token.id`.
 */
export function extractPriceMap(portfolioValue: PriceMapInput): Map<string, string> {
  const priceMap = new Map<string, string>();
  for (const portfolioHolding of portfolioValue.holdings) {
    if (portfolioHolding.value === null) continue;
    const balance = new Decimal(portfolioHolding.balance);
    const value = new Decimal(portfolioHolding.value);
    if (balance.greaterThan(0) && !priceMap.has(portfolioHolding.tokenId)) {
      const price = value.div(balance);
      priceMap.set(portfolioHolding.tokenId, price.toString());
    }
  }
  return priceMap;
}
