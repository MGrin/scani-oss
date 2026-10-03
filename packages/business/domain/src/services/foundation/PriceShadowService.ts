import type { DatabaseTransaction } from '@scani/db';
import type { Token } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { assetClassOf, priceAt, readingPairsFor } from '../../engine/price-at';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import { PricingService } from '../pricing/PricingService';
import { PRICE_HUBS } from '../pricing/price-hubs';
import { readingsByAsset } from './readings-by-asset';
import { type ShadowRunResult, ShadowRunService, type ShadowTally } from './ShadowRunService';
import { comparePrice, type LegacyPriceReading, readingTimes } from './shadow-comparison';

export interface PriceShadowInput {
  /** The instant each held token is priced at, by the engine and by both of today's resolvers. */
  asOf: Date;
  userId?: string;
}

/** A base currency and the users priced in it. */
interface Base {
  tokenId: string;
  userIds: string[];
}

/** The base of a user who has none. */
const USD_HUB = PRICE_HUBS.filter((hub) => hub.symbol === 'USD');

interface Asset {
  token: Token;
  typeCode: string | null;
}

/**
 * The nightly price shadow (D-10): each held token's engine price at `asOf`
 * beside the live resolver's (`PricingService.getCachedTokenPrices`) and the
 * price graph's (`PriceGraphService.convert`), in the base currency of each
 * user who holds it. A user with no base currency is priced in USD. Users who
 * share a base share its comparisons, so a difference names a token and a
 * base, never a user. The shadow writes only its report; the live resolver may
 * write the FX rates it fetches into `token_prices`, as a dashboard read does
 * (Review Focus 4).
 */
@Service()
export class PriceShadowService {
  private readonly runs = Container.get(ShadowRunService);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly tokens = Container.get(TokenRepository);
  private readonly graph = Container.get(PriceGraphService);
  private readonly pricing = Container.get(PricingService);

  /** One base at a time, each in a snapshot of its own (`ShadowRunService.run`). */
  run(input: PriceShadowInput, tx?: DatabaseTransaction): Promise<ShadowRunResult> {
    return this.runs.run(
      {
        kind: 'price',
        asOf: input.asOf,
        userId: input.userId,
        units: (setupTx) => this.basesOf(input.userId, setupTx),
        describe: (base) => `base ${base.tokenId}`,
        compare: (base, baseTx) => this.compareBase(base, input.asOf, baseTx),
      },
      tx
    );
  }

  /** In the order of each base's first user. */
  private async basesOf(userId: string | undefined, tx: DatabaseTransaction): Promise<Base[]> {
    const [usd] = await this.graph.resolveHubTokenIds(tx, USD_HUB);
    const bases = new Map<string, string[]>();
    for (const user of await this.evidence.findUsersWithHoldings(tx)) {
      if (userId !== undefined && user.userId !== userId) continue;
      const tokenId = user.baseCurrencyId ?? usd;
      if (tokenId === undefined) {
        throw new Error(
          `user ${user.userId} has no base currency, and the USD hub does not resolve`
        );
      }
      const userIds = bases.get(tokenId);
      if (userIds) userIds.push(user.userId);
      else bases.set(tokenId, [user.userId]);
    }
    return [...bases].map(([tokenId, userIds]) => ({ tokenId, userIds }));
  }

  /** The base's evidence is dropped when this returns; only the differences are kept. */
  private async compareBase(base: Base, asOf: Date, tx: DatabaseTransaction): Promise<ShadowTally> {
    const tally: ShadowTally = { compared: 0, differences: [] };
    const assets = await this.assetsOf(base.userIds, tx);
    if (assets.length === 0) return tally;

    const baseToken = await this.tokens.findById(base.tokenId, tx);
    if (baseToken === null) throw new Error(`base currency token ${base.tokenId} does not exist`);
    const hubTokenIds = await this.graph.resolveHubTokenIds(tx);
    const tokenIds = assets.map((a) => a.token.id);
    const pairs = readingPairsFor(tokenIds, base.tokenId, hubTokenIds);
    const routed = await this.evidence.findPriceReadings(pairs, asOf, tx);
    // `readingTimes` reads a token's newest row in ANY base, as the live
    // resolver does, so the rows quoted outside the routed pairs are loaded
    // too. `priceAt` reads only routed pairs, so it never sees them.
    const loaded = new Set(pairs.map(pairKey));
    const elsewhere = (await this.evidence.findLatestReadingsInAnyBase(tokenIds, asOf, tx)).filter(
      (reading) => !loaded.has(pairKey(reading))
    );
    const readings = [...routed, ...elsewhere];
    const readingsOf = readingsByAsset(readings, base.tokenId, hubTokenIds);
    const live = await this.pricing.getCachedTokenPrices(
      assets.map((a) => a.token),
      baseToken.symbol,
      asOf
    );
    const priceLookup = await this.graph.buildPriceLookup(tokenIds, base.tokenId, asOf, tx, asOf);

    for (const { token, typeCode } of assets) {
      const own = readingsOf(token.id);
      const engine = priceAt(
        { readings: own, hubTokenIds },
        { tokenId: token.id, assetClass: assetClassOf(typeCode) },
        base.tokenId,
        asOf
      );
      const times = readingTimes(own, token.id, base.tokenId, asOf);
      const graphed = await this.graph.convert('1', token.id, base.tokenId, asOf, {
        tx,
        priceLookup,
      });
      const legacy: LegacyPriceReading[] = [
        {
          comparator: 'live-resolver',
          price: live.get(token.id) ?? null,
          readingAt: null,
          path: null,
        },
        {
          comparator: 'price-graph',
          price: graphed?.rate.toFixed() ?? null,
          readingAt: graphed?.effectiveAt ?? null,
          path: graphed?.path ?? null,
        },
      ];

      for (const reading of legacy) {
        tally.compared += 1;
        const difference = comparePrice({ at: asOf, engine, legacy: reading, ...times });
        if (difference === null) continue;
        tally.differences.push({
          ...difference,
          userId: null,
          holdingId: null,
          tokenId: token.id,
          baseTokenId: base.tokenId,
        });
      }
    }

    return tally;
  }

  /** Every token the users hold, once. */
  private async assetsOf(userIds: readonly string[], tx: DatabaseTransaction): Promise<Asset[]> {
    const assets = new Map<string, Asset>();
    for (const userId of userIds) {
      for (const asset of await this.evidence.findPricedAssets(userId, tx)) {
        assets.set(asset.token.id, asset);
      }
    }
    return [...assets.values()];
  }
}

function pairKey(pair: { tokenId: string; baseTokenId: string }): string {
  return `${pair.tokenId}|${pair.baseTokenId}`;
}
