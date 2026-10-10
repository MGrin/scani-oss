import { Decimal } from '@scani/shared';
import { balanceAt } from '../../engine/balance-at';
import { compareText } from '../../engine/order';
import type { BalanceAt, HoldingEvidence, Observation } from '../../engine/types';
import { EXCLUSIONS } from './classified-counts';
import type { ClassifiedHolding } from './legacy-classification';
import type { ValueComparator, ValueDiffCategory } from './value-comparison';

/** In the order they are tried: the first that holds names the difference. */
export const BALANCE_DIFF_CATEGORIES = [
  'starts-at',
  ...EXCLUSIONS,
  'verification-not-anchor',
  'snapshot-first-anchor',
  'ledger-ahead-of-anchor',
  'column-without-evidence',
  'no-anchor',
  'unexplained',
] as const;
type BalanceDiffCategory = (typeof BALANCE_DIFF_CATEGORIES)[number];

// One comparator since A5 PR-2: `balance-at-time` compared the engine with
// the old history walk, and history now reads the engine (D-13).
type BalanceComparator = 'stored-balance';

export interface LegacyBalanceReading {
  balance: string;
  lastUpdated: Date;
}

export interface ShadowDifference {
  comparator: BalanceComparator | ValueComparator;
  category: BalanceDiffCategory | ValueDiffCategory;
  at: Date;
  engineValue: string | null;
  legacyValue: string | null;
  detail: Record<string, unknown>;
}

type DerivedBalance = Extract<BalanceAt, { status: 'derived' }>;
type RestoredRows = Partial<Pick<HoldingEvidence, 'observations' | 'entries'>>;

export function compareBalance(
  c: ClassifiedHolding,
  at: Date,
  legacy: LegacyBalanceReading
): ShadowDifference | null {
  const engine = balanceAt(c.evidence, at);
  const derived = engine.status === 'derived' ? engine : null;
  const legacyBalance = legacy.balance;
  if (derived?.balance.eq(legacyBalance)) return null;

  return {
    comparator: 'stored-balance',
    category:
      derived === null
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
  if (engine.anchorAt !== null && legacy.lastUpdated > engine.anchorAt) {
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
