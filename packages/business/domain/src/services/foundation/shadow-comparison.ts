import { Decimal } from '@scani/shared';
import { balanceAt } from '../../engine/balance-at';
import { compareText } from '../../engine/order';
import type {
  BalanceAt,
  HoldingEvidence,
  Observation,
  PriceAt,
  PricePath,
  PriceReading,
} from '../../engine/types';
import { LIVE_PRICE_WINDOW_MS } from '../pricing/price-windows';
import { EXCLUSIONS } from './classified-counts';
import type { ClassifiedHolding } from './legacy-classification';

/** In the order they are tried: the first that holds names the difference. */
export const BALANCE_DIFF_CATEGORIES = [
  'starts-at',
  ...EXCLUSIONS,
  'verification-not-anchor',
  'driftAhead-interpolation',
  'floored-walk',
  'snapshot-first-anchor',
  'ledger-ahead-of-anchor',
  'column-without-evidence',
  'no-anchor',
  'unexplained',
] as const;
type BalanceDiffCategory = (typeof BALANCE_DIFF_CATEGORIES)[number];

/** In the order they are tried: the first that holds names the difference. */
export const PRICE_DIFF_CATEGORIES = [
  'engine-unpriced',
  'legacy-unpriced',
  'stale-fallback',
  'fresher-price',
  'route',
  'fx-leg',
  'unexplained',
] as const;
type PriceDiffCategory = (typeof PRICE_DIFF_CATEGORIES)[number];

export type BalanceComparator = 'stored-balance' | 'balance-at-time';
export type PriceComparator = 'live-resolver' | 'price-graph';

export interface LegacyBalanceReading {
  comparator: BalanceComparator;
  balance: string | null;
  absent: boolean;
  interpolated: boolean;
  floored: boolean;
  lastUpdated: Date | null;
}

export interface LegacyPriceReading {
  comparator: PriceComparator;
  price: string | null;
  readingAt: Date | null;
  /** `PriceGraphService.convert().path` as returned; the live resolver reports none. */
  path: string | null;
}

export interface ShadowDifference {
  comparator: BalanceComparator | PriceComparator;
  category: BalanceDiffCategory | PriceDiffCategory;
  at: Date;
  engineValue: string | null;
  legacyValue: string | null;
  detail: Record<string, unknown>;
}

interface PriceComparison {
  at: Date;
  engine: PriceAt | null;
  legacy: LegacyPriceReading;
  directReadingAt: Date | null;
  newestReadingAt: Date | null;
}

type DerivedBalance = Extract<BalanceAt, { status: 'derived' }>;
type RestoredRows = Partial<Pick<HoldingEvidence, 'observations' | 'entries'>>;

const PRICE_TOLERANCE = new Decimal('1e-9');
const GRAPH_ONE_HOP_PREFIX = 'one-hop-';

export function compareBalance(
  c: ClassifiedHolding,
  at: Date,
  legacy: LegacyBalanceReading
): ShadowDifference | null {
  const engine = balanceAt(c.evidence, at);
  const derived = engine.status === 'derived' ? engine : null;
  const legacyBalance = legacy.absent ? null : legacy.balance;
  if (derived === null && legacyBalance === null) return null;
  if (derived !== null && legacyBalance !== null && derived.balance.eq(legacyBalance)) return null;

  return {
    comparator: legacy.comparator,
    category:
      derived === null || legacyBalance === null
        ? 'starts-at'
        : balanceCategory(c, at, derived, legacy, new Decimal(legacyBalance)),
    at,
    engineValue: derived?.balance.toFixed() ?? null,
    legacyValue: legacyBalance,
    detail: {
      kind: c.evidence.kind,
      method: derived?.method ?? null,
      anchorAt: derived?.anchorAt?.toISOString() ?? null,
      entriesApplied: derived?.entriesApplied ?? null,
    },
  };
}

function balanceCategory(
  c: ClassifiedHolding,
  at: Date,
  engine: DerivedBalance,
  legacy: LegacyBalanceReading,
  legacyBalance: Decimal
): BalanceDiffCategory {
  const restores = (rows: RestoredRows) => {
    const result = restoredBalanceAt(c.evidence, rows, at);
    return result?.status === 'derived' && result.balance.eq(legacyBalance);
  };
  if (restores({ observations: c.excluded.fabricated })) return 'fabricated-observation';
  if (restores({ entries: c.excluded.openings })) return 'opening-row';
  if (restores({ entries: c.excluded.corrections })) return 'legacy-correction-row';

  const verified = latestVerification(c.evidence.observations, at);
  if (verified !== undefined && legacyBalance.eq(verified.amount)) return 'verification-not-anchor';
  if (legacy.interpolated) return 'driftAhead-interpolation';
  if (legacy.floored) return 'floored-walk';
  if (c.evidence.kind === 'snapshot' && engine.method === 'first-snapshot') {
    return 'snapshot-first-anchor';
  }

  const anchor = c.evidence.observations.find((o) => o.id === engine.anchorId);
  if (
    engine.method === 'forward' &&
    engine.entriesApplied > 0 &&
    anchor !== undefined &&
    legacyBalance.eq(anchor.amount)
  ) {
    return 'ledger-ahead-of-anchor';
  }
  if (
    legacy.comparator === 'stored-balance' &&
    engine.anchorAt !== null &&
    legacy.lastUpdated !== null &&
    legacy.lastUpdated > engine.anchorAt
  ) {
    return 'column-without-evidence';
  }
  if (engine.method === 'no-anchor') return 'no-anchor';
  return 'unexplained';
}

/**
 * The engine's answer had one excluded class been kept, on a copy. `startsAt`
 * drops to the earliest restored row because a legacy opening sits 1 ms before
 * the earliest real evidence (SC-481), outside the holding's own start.
 */
function restoredBalanceAt(
  evidence: HoldingEvidence,
  rows: RestoredRows,
  at: Date
): BalanceAt | null {
  const observations = rows.observations ?? [];
  const entries = rows.entries ?? [];
  if (observations.length === 0 && entries.length === 0) return null;
  let startsAt = evidence.startsAt;
  for (const row of [...observations, ...entries]) {
    if (row.at < startsAt) startsAt = row.at;
  }
  return balanceAt(
    {
      ...evidence,
      startsAt,
      observations: [...evidence.observations, ...observations],
      entries: [...evidence.entries, ...entries],
    },
    at
  );
}

/** Ties at one instant go to the later recorded, then the higher id, whatever the input order. */
function latestVerification(
  observations: readonly Observation[],
  at: Date
): Observation | undefined {
  let latest: Observation | undefined;
  for (const o of observations) {
    if (o.role !== 'verification' || o.supersededAt !== null || o.at > at) continue;
    if (latest === undefined || isLater(o, latest)) latest = o;
  }
  return latest;
}

function isLater(a: Observation, b: Observation): boolean {
  const order =
    a.at.getTime() - b.at.getTime() ||
    a.recordedAt.getTime() - b.recordedAt.getTime() ||
    compareText(a.id, b.id);
  return order > 0;
}

export function comparePrice(input: PriceComparison): ShadowDifference | null {
  const { at, engine, legacy } = input;
  if (engine === null && legacy.price === null) return null;
  if (engine !== null && legacy.price !== null && agrees(engine.price, legacy.price)) return null;
  return {
    comparator: legacy.comparator,
    category: priceCategory(input),
    at,
    engineValue: engine?.price.toFixed() ?? null,
    legacyValue: legacy.price,
    detail: {
      enginePath: engine?.path ?? null,
      engineReadingAt: isoOrNull(engine?.readingAt ?? null),
      engineStale: engine?.stale ?? null,
      legacyPath: legacy.path,
      legacyReadingAt: isoOrNull(legacy.readingAt),
      directReadingAt: isoOrNull(input.directReadingAt),
      newestReadingAt: isoOrNull(input.newestReadingAt),
    },
  };
}

function priceCategory(input: PriceComparison): PriceDiffCategory {
  const { at, engine, legacy, directReadingAt, newestReadingAt } = input;
  if (engine === null) return 'engine-unpriced';
  if (legacy.price === null) return 'legacy-unpriced';

  const live = legacy.comparator === 'live-resolver';
  if (live && (newestReadingAt === null || isBefore(newestReadingAt, liveWindowStart(at)))) {
    return 'stale-fallback';
  }
  const fresher = live
    ? engine.path !== 'direct' && isBefore(directReadingAt, engine.readingAt)
    : isBefore(legacy.readingAt, engine.readingAt);
  if (fresher) return 'fresher-price';
  if (
    !live &&
    legacy.readingAt?.getTime() === engine.readingAt.getTime() &&
    legacy.path !== null &&
    graphRoute(legacy.path) !== engineRoute(engine.path)
  ) {
    return 'route';
  }
  if (live && (engine.path === 'inverse' || engine.path.startsWith('hub:'))) return 'fx-leg';
  return 'unexplained';
}

/** Relative: `|a − b| ≤ max(|a|, |b|) × 1e-9`. */
function agrees(engine: Decimal, legacy: string): boolean {
  const other = new Decimal(legacy);
  const scale = Decimal.max(engine.abs(), other.abs());
  return engine.minus(other).abs().lte(scale.times(PRICE_TOLERANCE));
}

function liveWindowStart(at: Date): Date {
  return new Date(at.getTime() - LIVE_PRICE_WINDOW_MS);
}

function isBefore(a: Date | null, b: Date): boolean {
  return a !== null && a.getTime() < b.getTime();
}

/**
 * The graph reports a hub hop as `one-hop-<id>` and an inverted row as
 * `direct`, so both vocabularies meet as the engine's, with `inverse` folded
 * into `direct`. Anything else the graph says (`two-hop-…`) is a route the
 * engine never takes, and stays different.
 */
function graphRoute(path: string): string {
  return path.startsWith(GRAPH_ONE_HOP_PREFIX)
    ? `hub:${path.slice(GRAPH_ONE_HOP_PREFIX.length)}`
    : path;
}

function engineRoute(path: PricePath): string {
  return path === 'inverse' ? 'direct' : path;
}

/**
 * When the token's own readings were taken, as the live resolver reads them:
 * rows quoting this token, the newest in `baseTokenId` and the newest in any
 * base. The price plays no part, since that resolver serves a row on its time
 * alone, a zero included.
 */
export function readingTimes(
  readings: readonly PriceReading[],
  tokenId: string,
  baseTokenId: string,
  at: Date
): { directReadingAt: Date | null; newestReadingAt: Date | null } {
  let directReadingAt: Date | null = null;
  let newestReadingAt: Date | null = null;
  for (const r of readings) {
    if (r.tokenId !== tokenId || r.at > at) continue;
    if (newestReadingAt === null || r.at > newestReadingAt) newestReadingAt = r.at;
    if (r.baseTokenId === baseTokenId && (directReadingAt === null || r.at > directReadingAt)) {
      directReadingAt = r.at;
    }
  }
  return { directReadingAt, newestReadingAt };
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}
