import { type ClassifiedHolding, STALE_LABEL_NOTE } from './legacy-classification';

/**
 * What classification sets aside as never evidence, in the order the balance
 * shadow tries each to explain a difference.
 */
export const EXCLUSIONS = [
  'fabricated-observation',
  'opening-row',
  'legacy-correction-row',
] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

export interface RowCounts {
  holdings: number;
  observations: number;
  entries: number;
}

/**
 * What classification left to write and what it set aside, summed over
 * holdings. The one place `ClassifiedHolding`'s counts become report keys, so
 * the backfill and the shadow cannot count them differently.
 */
export interface ClassifiedCounts {
  /** Rows with a label still to write: the rows `fillMissingLabels` would update. */
  unlabelled: RowCounts;
  excluded: Record<Exclusion, number>;
  /** Ledger labels with no decision behind them that their rows have moved away from (`stale-label`). */
  staleLabels: number;
}

export function emptyClassifiedCounts(): ClassifiedCounts {
  return {
    unlabelled: { holdings: 0, observations: 0, entries: 0 },
    excluded: { 'fabricated-observation': 0, 'opening-row': 0, 'legacy-correction-row': 0 },
    staleLabels: 0,
  };
}

export function addClassified(into: ClassifiedCounts, holding: ClassifiedHolding): void {
  if (holding.unlabelled.holding) into.unlabelled.holdings += 1;
  into.unlabelled.observations += holding.unlabelled.observations;
  into.unlabelled.entries += holding.unlabelled.entries;
  into.excluded['fabricated-observation'] += holding.excluded.fabricated.length;
  into.excluded['opening-row'] += holding.excluded.openings.length;
  into.excluded['legacy-correction-row'] += holding.excluded.corrections.length;
  into.staleLabels += holding.notes[STALE_LABEL_NOTE] ?? 0;
}

export function addClassifiedCounts(into: ClassifiedCounts, from: ClassifiedCounts): void {
  into.unlabelled.holdings += from.unlabelled.holdings;
  into.unlabelled.observations += from.unlabelled.observations;
  into.unlabelled.entries += from.unlabelled.entries;
  into.excluded['fabricated-observation'] += from.excluded['fabricated-observation'];
  into.excluded['opening-row'] += from.excluded['opening-row'];
  into.excluded['legacy-correction-row'] += from.excluded['legacy-correction-row'];
  into.staleLabels += from.staleLabels;
}
