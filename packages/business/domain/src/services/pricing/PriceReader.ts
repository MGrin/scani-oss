import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { Container, Service } from 'typedi';
import { assetClassOf, priceAt, readingPairsFor } from '../../engine/price-at';
import { indexPriceEvidence, type PriceIndex } from '../../engine/price-index';
import type {
  AssetClass,
  PriceAsk,
  PriceAt,
  PriceEvidence,
  PriceReading,
} from '../../engine/types';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PriceHubResolver } from './PriceHubResolver';

/** The prices one load was asked for. */
export interface PriceSeries {
  /** Throws RangeError when this (token, instant) was not asked. */
  priceAt(tokenId: string, at: Date): PriceAt | null;
  /** md5 over the loaded readings, independent of their order. */
  readonly fingerprint: string;
}

/**
 * The only loader of readings for a price. For each token and instant asked it
 * reads, of every pair the engine could route that token through, the rows at
 * the nearest stamp at or before the instant, and the engine's `priceAt`
 * answers over them. It never reads a pair's history.
 */
@Service()
export class PriceReader {
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly tokens = Container.get(TokenRepository);
  private readonly hubs = Container.get(PriceHubResolver);

  /** An entry for every id asked, `null` when unpriced. */
  async at(
    tokenIds: readonly string[],
    baseTokenId: string,
    at: Date,
    tx?: DatabaseTransaction
  ): Promise<ReadonlyMap<string, PriceAt | null>> {
    const series = await this.series(
      tokenIds.map((tokenId) => ({ tokenId, at })),
      baseTokenId,
      tx
    );
    return new Map(tokenIds.map((tokenId) => [tokenId, series.priceAt(tokenId, at)]));
  }

  /**
   * Each token's earliest stored reading, in any base: nothing is priced before
   * it, so a drift opening waits for it (SC-1638). A token with no reading is
   * absent.
   */
  async firstReadingAt(
    tokenIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<Map<string, Date>> {
    return this.evidence.findFirstPriceInstants(tokenIds, tx);
  }

  /**
   * One pair's stored rows as typed, not a price: a valued asset's history in
   * its own currency (SC-1643). Nothing is routed or converted.
   */
  async pairHistory(
    tokenId: string,
    baseTokenId: string,
    range?: { from: Date; until: Date },
    tx?: DatabaseTransaction
  ): Promise<{ price: string; timestamp: Date }[]> {
    return this.evidence.findPairReadings(tokenId, baseTokenId, range, tx);
  }

  /**
   * A fixed number of statements whatever is asked: once the hubs are known,
   * one for the quote currencies, one for the token types, one for the readings.
   */
  async series(
    asks: readonly PriceAsk[],
    baseTokenId: string,
    tx?: DatabaseTransaction
  ): Promise<PriceSeries> {
    const asked = instantsByToken(asks);
    if (asked.size === 0) {
      return new LoadedPrices({ readings: [], hubTokenIds: [] }, asked, baseTokenId);
    }
    const tokenIds = [...asked.keys()];
    const hubTokenIds = await this.hubs.hubTokenIds(tx);
    const quoteTokenIds = await this.evidence.findQuoteTokenIds(tokenIds, latestOf(asks), tx);
    const assetClasses = await this.classesOf(
      [...tokenIds, ...hubTokenIds, ...[...quoteTokenIds.values()].flat()],
      tx
    );

    const pairAsks: Array<{ tokenId: string; baseTokenId: string; at: Date }> = [];
    for (const [tokenId, instants] of asked) {
      for (const pair of readingPairsFor([tokenId], baseTokenId, hubTokenIds, quoteTokenIds)) {
        for (const instant of instants) pairAsks.push({ ...pair, at: new Date(instant) });
      }
    }
    const readings = await this.evidence.findPriceReadingsAtInstants(pairAsks, tx);
    return new LoadedPrices(
      { readings, hubTokenIds, quoteTokenIds, assetClasses },
      asked,
      baseTokenId
    );
  }

  private async classesOf(
    tokenIds: Iterable<string>,
    tx?: DatabaseTransaction
  ): Promise<Map<string, AssetClass>> {
    const tokens = await this.tokens.findManyWithTypes([...new Set(tokenIds)], tx);
    return new Map(tokens.map((token) => [token.id, assetClassOf(token.typeCode)]));
  }
}

/** Indexed once when loaded, so each ask is a lookup. */
class LoadedPrices implements PriceSeries {
  private readonly index: PriceIndex;
  private hash: string | null = null;

  constructor(
    private readonly evidence: PriceEvidence,
    private readonly asked: ReadonlyMap<string, ReadonlySet<number>>,
    private readonly baseTokenId: string
  ) {
    this.index = indexPriceEvidence(evidence);
  }

  priceAt(tokenId: string, at: Date): PriceAt | null {
    if (!this.asked.get(tokenId)?.has(at.getTime())) {
      throw new RangeError(
        `the price of token ${tokenId} at ${at.toISOString()} was not asked for when this series was loaded`
      );
    }
    const assetClass = this.evidence.assetClasses?.get(tokenId) ?? 'unknown';
    return priceAt(this.index, { tokenId, assetClass }, this.baseTokenId, at);
  }

  get fingerprint(): string {
    this.hash ??= fingerprintOf(this.evidence.readings);
    return this.hash;
  }
}

function instantsByToken(asks: readonly PriceAsk[]): Map<string, Set<number>> {
  const asked = new Map<string, Set<number>>();
  for (const ask of asks) {
    const instants = asked.get(ask.tokenId);
    if (instants) instants.add(ask.at.getTime());
    else asked.set(ask.tokenId, new Set([ask.at.getTime()]));
  }
  return asked;
}

function latestOf(asks: readonly PriceAsk[]): Date {
  let latest = Number.NEGATIVE_INFINITY;
  for (const ask of asks) latest = Math.max(latest, ask.at.getTime());
  return new Date(latest);
}

function fingerprintOf(readings: readonly PriceReading[]): string {
  const lines = readings.map((reading) =>
    JSON.stringify([
      reading.tokenId,
      reading.baseTokenId,
      reading.at.getTime(),
      reading.granularity,
      reading.price,
      reading.source,
    ])
  );
  return createHash('md5').update(lines.sort().join('\n')).digest('hex');
}
