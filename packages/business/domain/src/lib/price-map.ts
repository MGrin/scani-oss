interface PriceMapInput {
  holdings: Array<{
    tokenId: string;
    // `null` for unpriceable holdings — those are skipped so the
    // returned map only contains tokens we can actually price.
    currentPrice: string | null;
  }>;
}

/**
 * Per-token unit price, as the live valuation priced it.
 *
 * Keyed on the TOKEN ID, never the symbol. A symbol is not unique — a
 * `private-company` token and a crypto token can carry the same one — so a
 * symbol-keyed map holds one price for two different assets and every consumer
 * below values both of them at it (SC-1114). Callers must look up with
 * `token.id`.
 *
 * The price is read, never derived from value ÷ balance, so every balance
 * prices its token: a negative one, since margin debt is negative cash
 * (SC-1462) and a currency held only as debt would otherwise drop out of every
 * figure built on this map while net worth still counts it (SC-1463), and a
 * zero one.
 */
export function extractPriceMap(portfolioValue: PriceMapInput): Map<string, string> {
  const priceMap = new Map<string, string>();
  for (const holding of portfolioValue.holdings) {
    if (holding.currentPrice !== null && !priceMap.has(holding.tokenId)) {
      priceMap.set(holding.tokenId, holding.currentPrice);
    }
  }
  return priceMap;
}
