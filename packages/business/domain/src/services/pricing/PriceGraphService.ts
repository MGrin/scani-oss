import type { TokenPriceGranularity } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import type { PriceLookup } from './PriceLookup';

export interface PriceGraphConversion {
  // The resulting amount, already denominated in toTokenId.
  amount: Decimal;
  // The effective exchange rate used (per unit of fromToken).
  rate: Decimal;
  // The timestamp of the oldest price edge consulted (the binding leg).
  effectiveAt: Date;
  // 'direct' | 'one-hop-{HUB}' | 'two-hop-{HUB1}-{HUB2}'.
  path: string;
}

export interface PriceGraphOptions {
  // Prefer this granularity at each leg when reading `token_prices`.
  preferGranularity?: TokenPriceGranularity;
  // Symbols of tokens to use as hubs when no direct edge exists.
  // Evaluated in order; first hub whose legs resolve wins.
  // Defaults to ['USD', 'USDT', 'EUR']. User's display base is folded in
  // automatically by PortfolioValuationAtTimeService when it has one.
  hubSymbols?: string[];
  // Max path depth. 1 = direct only. 2 = allow one hub (recommended).
  // 3 = allow two hubs; rarely useful, costs extra lookups.
  maxDepth?: 1 | 2 | 3;
  // Optional pre-fetched price index. When set, tryDirect reads from
  // the in-memory dataset instead of the DB; falls back to the repo
  // only for pairs the lookup didn't preload (defensive). Used by the
  // rollup hot-path to avoid 80k DB round-trips per backfill.
  priceLookup?: PriceLookup;
}

// Conversion token-to-token across time via the price graph implied by
// `token_prices` rows. No USD-canonical assumption; every price is read
// in the base it was quoted in.
//
// Path rules:
//   1. Same token: identity (amount, rate=1, at=now).
//   2. Direct lookup (from→to) at or before `at`, preferred granularity.
//   3. Reverse direct: if (to→from) exists, use 1/price.
//   4. One-hop via each hub in order (from→H, H→to, or reversed).
//   5. Two-hop via pairs of hubs (rare, only when allowed).
//   6. Otherwise null — caller must tolerate.
@Service()
export class PriceGraphService {
  private readonly logger = createComponentLogger('service:PriceGraphService');
  // Small cache scoped to the service instance for the hub-symbol → token-id
  // lookup. Invalidated on process restart; that's fine — tokens are seeded
  // by migration and stable for the process lifetime.
  private hubIdCache = new Map<string, string>();

  // Class-field DI — see note in BalanceAtTimeService.ts.
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenRepository = Container.get(TokenRepository);

  async convert(
    amount: Decimal | string,
    fromTokenId: string,
    toTokenId: string,
    at: Date,
    options: PriceGraphOptions = {}
  ): Promise<PriceGraphConversion | null> {
    const amt = amount instanceof Decimal ? amount : new Decimal(amount);
    if (fromTokenId === toTokenId) {
      return {
        amount: amt,
        rate: new Decimal(1),
        effectiveAt: at,
        path: 'identity',
      };
    }

    const prefer = options.preferGranularity ?? null;
    const maxDepth = options.maxDepth ?? 2;
    const lookup = options.priceLookup ?? null;

    // Depth 1 — direct.
    const direct = await this.tryDirect(fromTokenId, toTokenId, at, prefer, lookup);
    if (direct) {
      return {
        amount: amt.mul(direct.rate),
        rate: direct.rate,
        effectiveAt: direct.at,
        path: 'direct',
      };
    }

    if (maxDepth < 2) return null;

    // Depth 2 — one hop via a hub. Dedup the id list: two configured
    // hub symbols may resolve to the same tokens.id (USD and a fiat
    // stablecoin aliased to the same token, or a future alias table),
    // and a repeated id in the two-hop loop produces degenerate paths
    // (`A → hub → same-hub → B` yielding rate = p × 1/p = 1, which
    // looks valid but is noise).
    const hubIds = [...new Set(await this.resolveHubTokenIds(options.hubSymbols))];
    for (const hubId of hubIds) {
      if (hubId === fromTokenId || hubId === toTokenId) continue;
      const legA = await this.tryDirect(fromTokenId, hubId, at, prefer, lookup);
      if (!legA) continue;
      const legB = await this.tryDirect(hubId, toTokenId, at, prefer, lookup);
      if (!legB) continue;
      const rate = legA.rate.mul(legB.rate);
      // "Binding" leg is whichever has the older (more stale) timestamp —
      // that's the weakest link in the chain, so report it as effectiveAt.
      const effectiveAt = legA.at < legB.at ? legA.at : legB.at;
      return {
        amount: amt.mul(rate),
        rate,
        effectiveAt,
        path: `one-hop-${hubId}`,
      };
    }

    if (maxDepth < 3) return null;

    // Depth 3 — two hops (bridging two hubs). Rare; only runs when the
    // hub list can't directly bridge. Hard cap on iterations so a
    // future expansion of `PRICE_HUB_SYMBOLS` (today: USD, USDT, EUR)
    // doesn't quietly turn this into an O(hubCount^2) hot-loop in
    // the rollup. At 3 hubs we walk ≤6 (hubA,hubB) pairs; 10 leaves
    // headroom for going up to ~5 hubs without a config change.
    const TWO_HOP_ITERATION_CAP = 10;
    let iterations = 0;
    twoHopOuter: for (const hubA of hubIds) {
      if (hubA === fromTokenId || hubA === toTokenId) continue;
      const legA = await this.tryDirect(fromTokenId, hubA, at, prefer, lookup);
      if (!legA) continue;
      for (const hubB of hubIds) {
        if (++iterations > TWO_HOP_ITERATION_CAP) break twoHopOuter;
        if (hubB === hubA) continue;
        if (hubB === fromTokenId || hubB === toTokenId) continue;
        const legB = await this.tryDirect(hubA, hubB, at, prefer, lookup);
        if (!legB) continue;
        const legC = await this.tryDirect(hubB, toTokenId, at, prefer, lookup);
        if (!legC) continue;
        const rate = legA.rate.mul(legB.rate).mul(legC.rate);
        const effectiveAt = [legA.at, legB.at, legC.at].reduce((a, b) => (a < b ? a : b));
        return {
          amount: amt.mul(rate),
          rate,
          effectiveAt,
          path: `two-hop-${hubA}-${hubB}`,
        };
      }
    }

    this.logger.debug(
      { fromTokenId, toTokenId, at, maxDepth, hubIds },
      'PriceGraphService: no path found'
    );
    return null;
  }

  // Try a direct edge between two tokens. Uses the forward price if
  // available; otherwise inverts a reverse price. Returns null when
  // neither exists. When a `priceLookup` is supplied (rollup hot-path
  // only), reads from the in-memory index instead of the DB.
  private async tryDirect(
    fromTokenId: string,
    toTokenId: string,
    at: Date,
    prefer: TokenPriceGranularity | null,
    lookup: PriceLookup | null
  ): Promise<{ rate: Decimal; at: Date } | null> {
    const forward = lookup
      ? lookup.findClosestByGranularity(fromTokenId, toTokenId, at, prefer)
      : await this.tokenPriceRepository.findClosestPriceByGranularity(
          fromTokenId,
          toTokenId,
          at,
          prefer
        );
    if (forward) {
      return { rate: new Decimal(forward.price), at: forward.timestamp };
    }
    const reverse = lookup
      ? lookup.findClosestByGranularity(toTokenId, fromTokenId, at, prefer)
      : await this.tokenPriceRepository.findClosestPriceByGranularity(
          toTokenId,
          fromTokenId,
          at,
          prefer
        );
    if (reverse) {
      const rp = new Decimal(reverse.price);
      if (rp.isZero()) return null;
      return { rate: new Decimal(1).div(rp), at: reverse.timestamp };
    }
    return null;
  }

  private async resolveHubTokenIds(symbolsOverride?: string[]): Promise<string[]> {
    const symbols = symbolsOverride ?? ['USD', 'USDT', 'EUR'];
    const ids: string[] = [];
    for (const symbol of symbols) {
      const cached = this.hubIdCache.get(symbol);
      if (cached) {
        ids.push(cached);
        continue;
      }
      const token = await this.tokenRepository.findBySymbol(symbol);
      if (token) {
        this.hubIdCache.set(symbol, token.id);
        ids.push(token.id);
      }
    }
    return ids;
  }
}
