/**
 * The dry run must say what the write does — for BOTH writes (SC-376, SC-378).
 *
 * These are the unit half; `TransferReviewService.test.ts` holds the half that
 * proves `unlinkPair` and `withdrawSameHoldingPairing` refuse through these
 * same functions against a real database, which is what makes agreement here
 * mean agreement there.
 */

import { describe, expect, test } from 'bun:test';
import {
  type RepairLegFacts,
  sameHoldingRepairPlan,
  unlinkPairRefusal,
  withdrawPairingRefusal,
} from '../../src/lib/transfer-unlink';

const HOLDING = 'holding-1';

/** Two legs of one holding from two different Solana transactions — the shape
 *  `sameHoldingGroupVerdict` calls a matcher artifact, so the verdict gate is
 *  never what refuses these. */
const artifactLegs = (reviews: ReadonlyArray<string | null>): ReadonlyArray<RepairLegFacts> =>
  reviews.map((transferReview, i) => ({
    id: `leg-${i}`,
    holdingId: HOLDING,
    source: 'solana',
    eventKey: `sig-${i}`,
    transferReview,
  }));

describe('unlinkPairRefusal', () => {
  test('is null when no leg carries an answer', () => {
    expect(unlinkPairRefusal([{ transferReview: null }, { transferReview: null }])).toBeNull();
  });

  test('refuses when ANY leg is answered, not only when all are', () => {
    const refusal = unlinkPairRefusal([{ transferReview: 'paired' }, { transferReview: null }]);
    expect(refusal?.reason).toBe('reviewed');
    expect(refusal?.detail).toContain('1 of 2 leg(s) answered');
    expect(refusal?.detail).toContain('paired');
  });

  test('names every distinct answer, so the reader knows what to reopen', () => {
    const refusal = unlinkPairRefusal([
      { transferReview: 'left_control' },
      { transferReview: 'paired' },
    ]);
    expect(refusal?.detail).toContain('left_control, paired');
  });
});

/**
 * THE SCOPE OF SC-378, AS A GATE RATHER THAN AS CARE.
 *
 * `withdrawSameHoldingPairing` clears an answer a person gave. Every test here
 * is an attempt to reach that write from a group where it would be an
 * overwrite rather than a withdrawal, and each one has to come back refused —
 * because the service passes the legs it read to this function and has no
 * other way through.
 */
describe('withdrawPairingRefusal — what may have its answer withdrawn', () => {
  test('an answered same-holding artifact is the one case it permits', () => {
    expect(withdrawPairingRefusal(artifactLegs(['paired', null]))).toBeNull();
  });

  test('a group spanning two holdings is refused — a real move, whoever answered it', () => {
    const refusal = withdrawPairingRefusal([
      { id: 'a', holdingId: 'a', source: 'solana', eventKey: 'sig-0', transferReview: 'paired' },
      { id: 'b', holdingId: 'b', source: 'solana', eventKey: 'sig-1', transferReview: null },
    ]);
    expect(refusal?.reason).toBe('not_artifact');
    expect(refusal?.detail).toContain('spans two holdings');
  });

  test('one upstream event on one holding is refused — a real no-op, not an artifact', () => {
    const refusal = withdrawPairingRefusal([
      { id: 'a', holdingId: HOLDING, source: 'solana', eventKey: 'sig', transferReview: 'paired' },
      { id: 'b', holdingId: HOLDING, source: 'solana', eventKey: 'sig', transferReview: null },
    ]);
    expect(refusal?.reason).toBe('not_artifact');
  });

  /** Kraken and the created `transfer-review` deposit both read null here, and
   *  null means "unreadable", never "different". Unproven refuses. */
  test('an unreadable event id is refused rather than assumed different', () => {
    const refusal = withdrawPairingRefusal([
      { id: 'a', holdingId: HOLDING, source: 'wise', eventKey: null, transferReview: 'paired' },
      { id: 'b', holdingId: HOLDING, source: 'wise', eventKey: null, transferReview: null },
    ]);
    expect(refusal?.reason).toBe('not_artifact');
  });

  test('an artifact nobody answered is refused — that one belongs to unlinkPair', () => {
    const refusal = withdrawPairingRefusal(artifactLegs([null, null]));
    expect(refusal?.reason).toBe('no_answer');
    expect(refusal?.detail).toContain('unlinkPair');
  });
});

describe('sameHoldingRepairPlan — the dry run and the writes agree', () => {
  test('an unanswered artifact is projected as unlinkable', () => {
    const p = sameHoldingRepairPlan(artifactLegs([null, null]));
    expect(p.verdict.unlink).toBe(true);
    expect(p.action).toBe('unlink');
    expect(p.refusal).toBeNull();
    expect(p.clears).toEqual([]);
  });

  /**
   * THE ONE THAT MATTERS. This is SC-376's production shape exactly: seven
   * groups the verdict calls artifacts, each with one leg answered `paired`.
   * The projection before SC-376 returned the verdict and nothing else, so it
   * said "would be unlinked" and `--apply` then refused all seven; SC-378 is
   * what makes the honest answer something other than REFUSED.
   *
   * Routing this back to `unlink` — returning `verdict.unlink` in place of
   * asking both gates — fails this assertion and no other, which is the check
   * that this test covers the defect rather than the happy path.
   */
  test('an artifact whose leg is answered is a WITHDRAW, and names the answer it clears', () => {
    const p = sameHoldingRepairPlan(artifactLegs(['paired', null]));
    expect(p.verdict.unlink).toBe(true);
    expect(p.action).toBe('withdraw');
    expect(p.refusal).toBeNull();
    expect(p.clears.map((leg) => leg.id)).toEqual(['leg-0']);
  });

  /** A group the verdict keeps is never handed to either write, so its legs'
   *  answers are a refusal reason the reader is not owed and must not be
   *  shown one — the summary counts these two states separately. */
  test('a non-artifact is kept for the verdict reason, with no write-path refusal attached', () => {
    const p = sameHoldingRepairPlan([
      {
        id: 'a',
        holdingId: HOLDING,
        source: 'solana',
        eventKey: 'sig-same',
        transferReview: 'paired',
      },
      { id: 'b', holdingId: HOLDING, source: 'solana', eventKey: 'sig-same', transferReview: null },
    ]);
    expect(p.action).toBe('keep');
    expect(p.refusal).toBeNull();
    expect(p.verdict.reason).toContain('KEEP');
  });

  test('a group spanning two holdings is kept even with every leg unanswered', () => {
    const p = sameHoldingRepairPlan([
      { id: 'a', holdingId: 'a', source: 'solana', eventKey: 'sig-0', transferReview: null },
      { id: 'b', holdingId: 'b', source: 'solana', eventKey: 'sig-1', transferReview: null },
    ]);
    expect(p.action).toBe('keep');
    expect(p.refusal).toBeNull();
  });

  /** Every artifact reaches exactly one write and no group reaches both: the
   *  two gates are complements on the answered/unanswered split, so a change
   *  that widens one has to narrow the other to keep this passing. */
  test('the two writes are disjoint and together cover every artifact', () => {
    for (const reviews of [
      [null, null],
      ['paired', null],
      ['paired', 'left_control'],
    ] as ReadonlyArray<ReadonlyArray<string | null>>) {
      const legs = artifactLegs(reviews);
      const unlinkable = unlinkPairRefusal(legs) === null;
      const withdrawable = withdrawPairingRefusal(legs) === null;
      expect(unlinkable).not.toBe(withdrawable);
      expect(sameHoldingRepairPlan(legs).action).toBe(unlinkable ? 'unlink' : 'withdraw');
    }
  });
});
