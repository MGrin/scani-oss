import type { DatabaseTransaction } from '@scani/db';
import type { TokenPriceGranularity } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { MAX_DAILY_PRICE_AGE_MS, MAX_INTRADAY_PRICE_AGE_MS } from '../../lib/constants';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PriceLookup } from './PriceLookup';
import { PRICE_HUBS, type PriceHub, priceHubKey } from './price-hubs';

export interface PriceGraphConversion {
  // The resulting amount, already denominated in toTokenId.
  amount: Decimal;
  // The effective exchange rate used (per unit of fromToken).
  rate: Decimal;
  // The timestamp of the oldest price edge consulted (the binding leg).
  effectiveAt: Date;
  // 'direct' | 'one-hop-{HUB}' | 'two-hop-{HUB1}-{HUB2}'.
  path: string;
  // True when the binding leg's `effectiveAt` is older than the
  // granularity-appropriate staleness cap (see constants). The amount is
  // still returned — callers fold this into coverage_quality rather than
  // dropping the holding and fabricating a chart gap.
  stale: boolean;
}

export interface PriceGraphOptions {
  // Prefer this granularity at each leg when reading `token_prices`.
  preferGranularity?: TokenPriceGranularity;
  // Tokens to use as hubs when no direct edge exists, each pinned to its
  // type. Evaluated in order; first hub whose legs resolve wins.
  // Defaults to PRICE_HUBS.
  hubs?: readonly PriceHub[];
  // Max path depth. 1 = direct only. 2 = allow one hub (recommended).
  // 3 = allow two hubs; rarely useful, costs extra lookups.
  maxDepth?: 1 | 2 | 3;
  // Optional pre-fetched price index. When set, tryDirect reads from the
  // in-memory dataset instead of the DB for every pair the lookup was built
  // to cover, and falls back to the repository for the rest. Build it with
  // `buildPriceLookup` so the covered set matches what this walks.
  priceLookup?: PriceLookup;
  /**
   * The transaction every read on this call must go through, or `undefined`
   * for the connection pool.
   *
   * REQUIRED, and not `tx?:` — that is the whole point (SC-600). A test
   * running inside `withTestDb` gets a transaction the pool cannot see, so a
   * call that omits it does not fail: it reads an empty database and returns
   * `null`, and every assertion downstream goes on passing against nothing.
   * Measured 2026-08-23: inside one `withTestDb` callback the transaction saw
   * 1 holding and `PnLAtTimeService.getPnL` saw 0.
   *
   * Optional, that failure stays available at every call site nobody thought
   * about. Required, the compiler names them — and `undefined` remains the
   * right answer in production, it just has to be written down.
   */
  tx: DatabaseTransaction | undefined;
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
  // Small cache scoped to the service instance for the hub → token-id
  // lookup. Invalidated on process restart; that's fine — tokens are seeded
  // by migration and stable for the process lifetime. `null` is cached too:
  // a hub that does not resolve used to re-query on every single convert()
  // call, which is the hot path.
  private hubIdCache = new Map<string, string | null>();

  // Class-field DI — see note in BalanceAtTimeService.ts.
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

  async convert(
    amount: Decimal | string,
    fromTokenId: string,
    toTokenId: string,
    at: Date,
    options: PriceGraphOptions
  ): Promise<PriceGraphConversion | null> {
    const amt = amount instanceof Decimal ? amount : new Decimal(amount);
    if (fromTokenId === toTokenId) {
      return {
        amount: amt,
        rate: new Decimal(1),
        effectiveAt: at,
        path: 'identity',
        stale: false,
      };
    }

    const prefer = options.preferGranularity ?? null;
    const maxDepth = options.maxDepth ?? 2;
    const lookup = options.priceLookup ?? null;
    const tx = options.tx;
    // Daily-granularity lookups tolerate a wider staleness window than
    // intraday — thin-pair daily closes are legitimately weekly.
    const staleCap = prefer === 'daily' ? MAX_DAILY_PRICE_AGE_MS : MAX_INTRADAY_PRICE_AGE_MS;
    const isStale = (effectiveAt: Date): boolean => at.getTime() - effectiveAt.getTime() > staleCap;

    // Depth 1 — direct.
    const direct = await this.tryDirect(fromTokenId, toTokenId, at, prefer, lookup, tx);
    if (direct) {
      return {
        amount: amt.mul(direct.rate),
        rate: direct.rate,
        effectiveAt: direct.at,
        path: 'direct',
        stale: isStale(direct.at),
      };
    }

    if (maxDepth < 2) return null;

    // Depth 2 — one hop via a hub. Dedup the id list: two configured
    // hub symbols may resolve to the same tokens.id (USD and a fiat
    // stablecoin aliased to the same token, or a future alias table),
    // and a repeated id in the two-hop loop produces degenerate paths
    // (`A → hub → same-hub → B` yielding rate = p × 1/p = 1, which
    // looks valid but is noise).
    const hubIds = [...new Set(await this.resolveHubTokenIds(tx, options.hubs))];
    for (const hubId of hubIds) {
      if (hubId === fromTokenId || hubId === toTokenId) continue;
      const legA = await this.tryDirect(fromTokenId, hubId, at, prefer, lookup, tx);
      if (!legA) continue;
      const legB = await this.tryDirect(hubId, toTokenId, at, prefer, lookup, tx);
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
        stale: isStale(effectiveAt),
      };
    }

    if (maxDepth < 3) return null;

    // Depth 3 — two hops (bridging two hubs). Rare; only runs when the
    // hub list can't directly bridge. Hard cap on iterations so a
    // future expansion of `PRICE_HUBS` (today: USD, USDT, EUR)
    // doesn't quietly turn this into an O(hubCount^2) hot-loop in
    // the rollup. At 3 hubs we walk ≤6 (hubA,hubB) pairs; 10 leaves
    // headroom for going up to ~5 hubs without a config change.
    const TWO_HOP_ITERATION_CAP = 10;
    let iterations = 0;
    twoHopOuter: for (const hubA of hubIds) {
      if (hubA === fromTokenId || hubA === toTokenId) continue;
      const legA = await this.tryDirect(fromTokenId, hubA, at, prefer, lookup, tx);
      if (!legA) continue;
      for (const hubB of hubIds) {
        if (++iterations > TWO_HOP_ITERATION_CAP) break twoHopOuter;
        if (hubB === hubA) continue;
        if (hubB === fromTokenId || hubB === toTokenId) continue;
        const legB = await this.tryDirect(hubA, hubB, at, prefer, lookup, tx);
        if (!legB) continue;
        const legC = await this.tryDirect(hubB, toTokenId, at, prefer, lookup, tx);
        if (!legC) continue;
        const rate = legA.rate.mul(legB.rate).mul(legC.rate);
        const effectiveAt = [legA.at, legB.at, legC.at].reduce((a, b) => (a < b ? a : b));
        return {
          amount: amt.mul(rate),
          rate,
          effectiveAt,
          path: `two-hop-${hubA}-${hubB}`,
          stale: isStale(effectiveAt),
        };
      }
    }

    this.logger.debug(
      { fromTokenId, toTokenId, at, maxDepth, hubIds },
      'PriceGraphService: no path found'
    );
    return null;
  }

  // Prefetch every price row `convert` could consult for these tokens into
  // one index, in one query.
  //
  // The pair set is the union of everything `tryDirect` can ask for while
  // converting any of `tokenIds` to `baseCurrencyId`: each token against the
  // base and against every hub, both directions because a missing forward
  // edge is inverted from the reverse, plus the hub-to-hub legs the two-hop
  // path walks. It lives here rather than in a caller because that list is
  // this class's own traversal, and the rollup's copy of it carried a
  // "keep in sync" hazard whose failure mode is silent — a pair the preload
  // misses is a DB round-trip at best and, before `PriceLookup.covers`,
  // a fabricated "no price" at worst.
  async buildPriceLookup(
    tokenIds: Iterable<string>,
    baseCurrencyId: string,
    until: Date,
    tx: DatabaseTransaction | undefined
  ): Promise<PriceLookup> {
    const hubIds = await this.resolveHubTokenIds(tx);
    const baseAndHubs = new Set<string>([baseCurrencyId, ...hubIds]);
    const pairs: Array<{ tokenId: string; baseTokenId: string }> = [];
    const pushPair = (a: string, b: string): void => {
      if (a !== b) pairs.push({ tokenId: a, baseTokenId: b });
    };
    for (const tokenId of new Set(tokenIds)) {
      for (const other of baseAndHubs) {
        pushPair(tokenId, other);
        pushPair(other, tokenId);
      }
    }
    const anchors = [...baseAndHubs];
    for (const a of anchors) {
      for (const b of anchors) pushPair(a, b);
    }
    const rows = await this.tokenPriceRepository.findManyForPairsUpTo(pairs, until, tx);
    return new PriceLookup(rows, pairs);
  }

  // Try a direct edge between two tokens. Uses the forward price if
  // available; otherwise inverts a reverse price. Returns null when
  // neither exists.
  //
  // A supplied `priceLookup` answers for the pairs it was built to cover;
  // anything else still goes to the repository. Forward and reverse are
  // separate pairs and are decided separately, so a prefetch that covers one
  // direction does not suppress the read for the other.
  private async tryDirect(
    fromTokenId: string,
    toTokenId: string,
    at: Date,
    prefer: TokenPriceGranularity | null,
    lookup: PriceLookup | null,
    tx: DatabaseTransaction | undefined
  ): Promise<{ rate: Decimal; at: Date } | null> {
    const forward =
      lookup?.covers(fromTokenId, toTokenId) === true
        ? lookup.findClosestByGranularity(fromTokenId, toTokenId, at, prefer)
        : await this.tokenPriceRepository.findClosestPriceByGranularity(
            fromTokenId,
            toTokenId,
            at,
            prefer,
            tx
          );
    if (forward) {
      return { rate: new Decimal(forward.price), at: forward.timestamp };
    }
    const reverse =
      lookup?.covers(toTokenId, fromTokenId) === true
        ? lookup.findClosestByGranularity(toTokenId, fromTokenId, at, prefer)
        : await this.tokenPriceRepository.findClosestPriceByGranularity(
            toTokenId,
            fromTokenId,
            at,
            prefer,
            tx
          );
    if (reverse) {
      const rp = new Decimal(reverse.price);
      if (rp.isZero()) return null;
      return { rate: new Decimal(1).div(rp), at: reverse.timestamp };
    }
    return null;
  }

  // Resolve each hub to the `tokens` row it names. Public because the
  // nightly rollup prefetches every (token, hub) price pair into a
  // PriceLookup and has to preload the same ids this walks — it used to
  // keep its own hub list and its own resolver, with a "keep in sync"
  // comment and nothing that checked (SC-315).
  //
  // Each hub is resolved on `(symbol, typeId, marketSegment: null)`,
  // which the `tokens_symbol_type_segment_unique` constraint makes at
  // most one row. That matters because a symbol is not an identity here:
  ***REMOVED***
  // type alone still leaves `findBySymbolAndType`'s
  // `asc(isScamProbability), desc(createdAt)` tiebreak to guess between
  // the merged canonical row and one chain's ERC-20. The canonical row
  // is the one carrying the price edges (migration 0007 merged the
  // chain-spread duplicates into it and forced its segment to NULL), so
  // guessing the other one takes the entire USDT lane out of service —
  // every one-hop route through it fails and falls through to the next
  // hub, silently.
  async resolveHubTokenIds(
    tx: DatabaseTransaction | undefined,
    hubs: readonly PriceHub[] = PRICE_HUBS
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const hub of hubs) {
      const key = priceHubKey(hub);
      // The cache is BYPASSED under a transaction, in both directions, and
      // that is not caution — either direction is a wrong answer (SC-600).
      // Reading it would let a `null` resolved against the pool suppress a
      // hub the transaction has just seeded, taking that whole lane out of
      // service silently; writing it would leave an id from a rolled-back
      // transaction answering for every later pool read on this instance.
      // The cache exists because `convert` is the rollup's hot path, and
      // that path passes no transaction, so it is untouched.
      if (tx === undefined) {
        const cached = this.hubIdCache.get(key);
        if (cached !== undefined) {
          if (cached) ids.push(cached);
          continue;
        }
      }
      const id = await this.resolveHub(hub, tx);
      if (tx === undefined) this.hubIdCache.set(key, id);
      if (id) ids.push(id);
    }
    return ids;
  }

  private async resolveHub(
    hub: PriceHub,
    tx: DatabaseTransaction | undefined
  ): Promise<string | null> {
    const type = await this.tokenTypeRepository.findByCode(hub.typeCode, tx);
    if (!type) {
      this.logger.warn({ hub }, 'PriceGraphService: hub token type is not seeded, hub disabled');
      return null;
    }

    const canonical = await this.tokenRepository.findByIdentityTuple(hub.symbol, type.id, null, tx);
    if (canonical) return canonical.id;

    // No un-segmented row. Every hub is expected to have one, so this is
    // a database we don't recognise rather than a routing decision —
    // fall back to the type-scoped lookup so an existing lane keeps
    // working, but say out loud that the row was picked by a tiebreak.
    const segmented = await this.tokenRepository.findBySymbolAndType(hub.symbol, type.id, tx);
    if (segmented) {
      this.logger.warn(
        { hub, tokenId: segmented.id, marketSegment: segmented.marketSegment },
        'PriceGraphService: no canonical hub row, falling back to a tie-broken match'
      );
      return segmented.id;
    }

    this.logger.warn({ hub }, 'PriceGraphService: hub token not found, hub disabled');
    return null;
  }
}
