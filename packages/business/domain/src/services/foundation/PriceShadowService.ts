import type { DatabaseTransaction } from '@scani/db';
import type { Token, TokenPriceGranularity } from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { PriceAsk, PriceAt, PriceReading } from '../../engine/types';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import type { ShadowRunSummary } from '../../repositories/EngineShadowReportRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import type { PriceLookup } from '../pricing/PriceLookup';
import { PriceReader, type PriceSeries } from '../pricing/PriceReader';
import { PricingService } from '../pricing/PricingService';
import { PRICE_HUBS } from '../pricing/price-hubs';
import { type ShadowRunResult, ShadowRunService, type ShadowTally } from './ShadowRunService';
import {
  comparePrice,
  graphTypedIn,
  type LegacyPriceReading,
  liveTypedIn,
  readingTimes,
  readsTheEngineInstant,
  type ShadowDifference,
  valueAtStake,
} from './shadow-comparison';

export interface PriceShadowInput {
  /** The instant each held token is priced at, by the engine and by both of today's resolvers. */
  asOf: Date;
  /** Day closes before `asOf`, where the engine is compared against the graph asked for daily alone. */
  pastInstants?: readonly Date[];
  userId?: string;
}

/** One token's price in one base, differing between the engine and a legacy reader. */
export type PriceDifference = ShadowDifference & { tokenId: string; baseTokenId: string };

/** A base currency and the users priced in it. */
interface Base {
  tokenId: string;
  userIds: string[];
}

interface Compared {
  compared: number;
  differences: PriceDifference[];
}

/** The base of a user who has none. */
const USD_HUB = PRICE_HUBS.filter((hub) => hub.symbol === 'USD');

/** How the graph is asked: at `asOf` as today's live callers ask it, at a past close as the history readers do. */
interface GraphMode {
  comparator: 'price-graph' | 'price-graph-daily';
  prefer?: TokenPriceGranularity;
}

const GRAPH_AT_NOW: GraphMode = { comparator: 'price-graph' };
const GRAPH_DAILY: GraphMode = { comparator: 'price-graph-daily', prefer: 'daily' };

/** Of the granularities rows are written in, the one the engine ranks first at a tie. */
const ENGINE_TIE: TokenPriceGranularity = 'intraday';

/** The live resolver's reading times, which only its own comparison reads. */
const NO_READING_TIMES = { directReadingAt: null, newestReadingAt: null };

interface GraphAsk {
  tokenId: string;
  baseTokenId: string;
  at: Date;
  lookup: PriceLookup;
  tx: DatabaseTransaction | undefined;
}

/**
 * The nightly price shadow (D-10). The engine's answers come from
 * `PriceReader`, the path the live and history readers move onto. At `asOf`
 * each held token is compared with the live resolver
 * (`PricingService.getCachedTokenPrices`) and the price graph
 * (`PriceGraphService.convert`), each difference carrying the value at stake;
 * at each past day close, with the graph asked for daily alone. A user with no
 * base currency is priced in USD. Users who share a base share its
 * comparisons, so a difference names a token and a base, never a user. The
 * shadow writes only its report; the live resolver may write the FX rates it
 * fetches into `token_prices`, as a dashboard read does (Review Focus 4).
 */
@Service()
export class PriceShadowService {
  private readonly runs = Container.get(ShadowRunService);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly tokens = Container.get(TokenRepository);
  private readonly graph = Container.get(PriceGraphService);
  private readonly pricing = Container.get(PricingService);
  private readonly prices = Container.get(PriceReader);

  /** One base at a time, each in a snapshot of its own (`ShadowRunService.run`). */
  run(input: PriceShadowInput, tx?: DatabaseTransaction): Promise<ShadowRunResult> {
    const pastInstants = input.pastInstants ?? [];
    return this.runs.run(
      {
        kind: 'price',
        asOf: input.asOf,
        userId: input.userId,
        units: (setupTx) => this.basesOf(input.userId, setupTx),
        describe: (base) => `base ${base.tokenId}`,
        compare: (base, baseTx) => this.compareBase(base, input.asOf, pastInstants, baseTx),
        summarize: (differences) => summarize(differences, [input.asOf, ...pastInstants]),
      },
      tx
    );
  }

  /** The engine against the graph asked for daily, for any tokens and instants. Writes nothing. */
  async compareAt(
    asks: readonly PriceAsk[],
    baseTokenId: string,
    tx?: DatabaseTransaction
  ): Promise<PriceDifference[]> {
    const engine = await this.prices.series(asks, baseTokenId, tx);
    return (await this.againstDailyGraph(engine, asks, baseTokenId, tx)).differences;
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
  private async compareBase(
    base: Base,
    asOf: Date,
    pastInstants: readonly Date[],
    tx: DatabaseTransaction
  ): Promise<ShadowTally> {
    const tally: ShadowTally = { compared: 0, differences: [] };
    const assets = await this.assetsOf(base.userIds, tx);
    if (assets.length === 0) return tally;

    const baseToken = await this.tokens.findById(base.tokenId, tx);
    if (baseToken === null) throw new Error(`base currency token ${base.tokenId} does not exist`);
    const asksAt = (instants: readonly Date[]) =>
      instants.flatMap((at) => assets.map((token) => ({ tokenId: token.id, at })));
    const engine = await this.prices.series(asksAt([asOf, ...pastInstants]), base.tokenId, tx);

    const now = await this.compareNow(assets, baseToken, asOf, engine, base.userIds, tx);
    const past = await this.againstDailyGraph(engine, asksAt(pastInstants), base.tokenId, tx);
    for (const part of [now, past]) {
      tally.compared += part.compared;
      for (const difference of part.differences) {
        tally.differences.push({ ...difference, userId: null, holdingId: null });
      }
    }
    return tally;
  }

  /** At `asOf`: the live resolver and the graph as asked today, each difference with the value at stake. */
  private async compareNow(
    assets: Token[],
    baseToken: Token,
    asOf: Date,
    engine: PriceSeries,
    userIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<Compared> {
    const tokenIds = assets.map((token) => token.id);
    // A token's newest row in ANY base, as the live resolver chooses among them.
    const own = byToken(await this.evidence.findLatestReadingsInAnyBase(tokenIds, asOf, tx));
    const live = await this.pricing.getCachedTokenPrices(assets, baseToken, asOf);
    const lookup = await this.graph.buildPriceLookup(tokenIds, baseToken.id, asOf, tx, asOf);
    const balances = await this.balancesOf(userIds, tx);
    const result: Compared = { compared: 0, differences: [] };

    for (const token of assets) {
      const answer = engine.priceAt(token.id, asOf);
      const times = readingTimes(own.get(token.id) ?? [], token.id, baseToken.id, asOf);
      const liveReading: LegacyPriceReading = {
        comparator: 'live-resolver',
        price: live.get(token.id) ?? null,
        readingAt: null,
        path: null,
        typedIn: liveTypedIn(own.get(token.id) ?? [], token.id, baseToken.id, asOf),
      };
      const ask = { tokenId: token.id, baseTokenId: baseToken.id, at: asOf, lookup, tx };
      const differences = [
        comparePrice({
          at: asOf,
          baseTokenId: baseToken.id,
          engine: answer,
          legacy: liveReading,
          ...times,
        }),
        await this.againstGraph(answer, ask, GRAPH_AT_NOW, times),
      ];
      for (const difference of differences) {
        result.compared += 1;
        if (difference === null) continue;
        const stake = valueAtStake(
          balances.get(token.id) ?? [],
          difference.engineValue,
          difference.legacyValue
        );
        result.differences.push({
          ...difference,
          detail: { ...difference.detail, ...stake },
          tokenId: token.id,
          baseTokenId: baseToken.id,
        });
      }
    }
    return result;
  }

  /** Each ask against the graph asked for daily, through one lookup per instant. */
  private async againstDailyGraph(
    engine: PriceSeries,
    asks: readonly PriceAsk[],
    baseTokenId: string,
    tx: DatabaseTransaction | undefined
  ): Promise<Compared> {
    const result: Compared = { compared: 0, differences: [] };
    for (const [time, tokenIds] of tokensByInstant(asks)) {
      const at = new Date(time);
      const lookup = await this.graph.buildPriceLookup(tokenIds, baseTokenId, at, tx, at);
      for (const tokenId of tokenIds) {
        result.compared += 1;
        const difference = await this.againstGraph(
          engine.priceAt(tokenId, at),
          { tokenId, baseTokenId, at, lookup, tx },
          GRAPH_DAILY,
          NO_READING_TIMES
        );
        if (difference !== null) result.differences.push({ ...difference, tokenId, baseTokenId });
      }
    }
    return result;
  }

  /**
   * A difference read at the engine's instant is asked again with the tie
   * going to the engine's rank: agreement then means the two read rows that
   * differ only in granularity. Not through a quote currency, where
   * `quote-route` is decided first.
   */
  private async againstGraph(
    engine: PriceAt | null,
    ask: GraphAsk,
    mode: GraphMode,
    times: { directReadingAt: Date | null; newestReadingAt: Date | null }
  ): Promise<ShadowDifference | null> {
    const legacy = await this.graphReading(ask, mode.comparator, mode.prefer);
    const input = { at: ask.at, baseTokenId: ask.baseTokenId, engine, legacy, ...times };
    const difference = comparePrice(input);
    if (
      difference === null ||
      !readsTheEngineInstant(engine, legacy) ||
      engine?.path.startsWith('quote:')
    ) {
      return difference;
    }
    return comparePrice({
      ...input,
      finerTie: await this.graphReading(ask, mode.comparator, ENGINE_TIE),
    });
  }

  private async graphReading(
    ask: GraphAsk,
    comparator: GraphMode['comparator'],
    prefer: TokenPriceGranularity | undefined
  ): Promise<LegacyPriceReading> {
    const graphed = await this.graph.convert('1', ask.tokenId, ask.baseTokenId, ask.at, {
      tx: ask.tx,
      priceLookup: ask.lookup,
      ...(prefer === undefined ? {} : { preferGranularity: prefer }),
    });
    return {
      comparator,
      price: graphed?.rate.toFixed() ?? null,
      readingAt: graphed?.effectiveAt ?? null,
      path: graphed?.path ?? null,
      typedIn:
        graphed === null ? null : graphTypedIn(ask.lookup, ask, graphed.path, prefer ?? null),
    };
  }

  /** Every token the users hold, once. */
  private async assetsOf(userIds: readonly string[], tx: DatabaseTransaction): Promise<Token[]> {
    const assets = new Map<string, Token>();
    for (const userId of userIds) {
      for (const { token } of await this.evidence.findPricedAssets(userId, tx)) {
        assets.set(token.id, token);
      }
    }
    return [...assets.values()];
  }

  /** Per token, the balance of each of the users' holdings the shared inclusion rule counts. */
  private async balancesOf(
    userIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<Map<string, string[]>> {
    const balances = new Map<string, string[]>();
    for (const userId of userIds) {
      const held = await this.holdings.findByUser(userId, tx, true);
      const counted = await this.holdings.findIdsIncludedInTotal(
        held.map((holding) => holding.id),
        tx
      );
      for (const holding of held) {
        if (!counted.has(holding.id)) continue;
        const own = balances.get(holding.tokenId);
        if (own) own.push(holding.balance);
        else balances.set(holding.tokenId, [holding.balance]);
      }
    }
    return balances;
  }
}

function byToken(readings: readonly PriceReading[]): Map<string, PriceReading[]> {
  const grouped = new Map<string, PriceReading[]>();
  for (const reading of readings) {
    const own = grouped.get(reading.tokenId);
    if (own) own.push(reading);
    else grouped.set(reading.tokenId, [reading]);
  }
  return grouped;
}

/** Each instant's tokens, once each, in the order asked. */
function tokensByInstant(asks: readonly PriceAsk[]): Map<number, string[]> {
  const instants = new Map<number, Set<string>>();
  for (const ask of asks) {
    const tokenIds = instants.get(ask.at.getTime());
    if (tokenIds) tokenIds.add(ask.tokenId);
    else instants.set(ask.at.getTime(), new Set([ask.tokenId]));
  }
  return new Map([...instants].map(([time, tokenIds]) => [time, [...tokenIds]]));
}

/**
 * Every instant compared, with its differences by category, so an instant
 * where everything matched reads `{}` rather than being absent; and per base
 * and comparator, the value at stake of the differences that carry one.
 */
function summarize(
  differences: ShadowTally['differences'],
  instants: readonly Date[]
): Pick<ShadowRunSummary, 'byInstant' | 'valueImpactByBase'> {
  const byInstant: Record<string, Record<string, number>> = {};
  for (const instant of instants) byInstant[instant.toISOString()] = {};
  const valueImpactByBase: Record<string, Record<string, string>> = {};
  for (const difference of differences) {
    const instant = difference.at.toISOString();
    const counts = byInstant[instant] ?? {};
    counts[difference.category] = (counts[difference.category] ?? 0) + 1;
    byInstant[instant] = counts;
    const impact = difference.detail.valueImpact;
    if (typeof impact !== 'string' || difference.baseTokenId === null) continue;
    const sums = valueImpactByBase[difference.baseTokenId] ?? {};
    sums[difference.comparator] = new Decimal(sums[difference.comparator] ?? 0)
      .plus(impact)
      .toFixed();
    valueImpactByBase[difference.baseTokenId] = sums;
  }
  return { byInstant, valueImpactByBase };
}
