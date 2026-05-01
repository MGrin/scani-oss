/**
 * `CloudHistoricalPricer` — `HistoricalPriceProvider` proxy.
 *
 * Sibling to `CloudCurrentPricer`; same forwarding pattern but adds
 * the `at` and range methods for backfill jobs. Concrete provider
 * directories that satisfy both capabilities (CoinGecko, DeFiLlama,
 * Finnhub) register a single `CloudHistoricalPricer` instance — the
 * registry slots it into both buckets via the duck-typed guards.
 */

import type { Token } from '@scani/db/schema';
import type { Capability, HistoricalPriceProvider } from '../capabilities';
import type { PriceQuote, ProviderContext } from '../types';
import type { CloudProviderClient } from './cloud-client';

export class CloudHistoricalPricer implements HistoricalPriceProvider {
  readonly capabilities: readonly Capability[] = ['current-price', 'historical-price'];

  constructor(
    readonly providerKey: string,
    private readonly client: CloudProviderClient,
    private readonly canPriceFn: (t: Token) => boolean = () => true
  ) {}

  canPrice(t: Token): boolean {
    return this.canPriceFn(t);
  }

  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    return this.client.fetchCurrentPrice({
      providerKey: this.providerKey,
      token: t,
      baseCurrencyId: ctx.baseCurrency.id,
    });
  }

  async fetchCurrentPrices(
    tokens: Token[],
    ctx: ProviderContext
  ): Promise<Map<string, PriceQuote>> {
    const filtered = tokens.filter((t) => this.canPrice(t));
    if (filtered.length === 0) return new Map();
    const rows = await this.client.fetchCurrentPrices({
      providerKey: this.providerKey,
      tokens: filtered,
      baseCurrencyId: ctx.baseCurrency.id,
    });
    return new Map(rows.map((r) => [r.tokenId, r.quote]));
  }

  async fetchHistoricalPrice(t: Token, at: Date, ctx: ProviderContext): Promise<PriceQuote | null> {
    return this.client.fetchHistoricalPrice({
      providerKey: this.providerKey,
      token: t,
      at,
      baseCurrencyId: ctx.baseCurrency.id,
    });
  }

  async fetchHistoricalRange(
    t: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    return this.client.fetchHistoricalRange({
      providerKey: this.providerKey,
      token: t,
      from,
      to,
      baseCurrencyId: ctx.baseCurrency.id,
    });
  }
}
