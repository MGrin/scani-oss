import { describe, expect, test } from 'bun:test';
import {
  isUsageFailure,
  summarizeOutcomes,
  USAGE_FAILURE_OUTCOMES,
  USAGE_OUTCOMES,
  USAGE_SUCCESS_OUTCOME,
} from '../../src/usage/outcomes';

/** Every reader of `cloud_usage_events.outcome` — the paid console's `/usage`
 *  and the admin dashboard's 24h tile — folds with this one module, so the
 *  fixtures below stand for all of them. */

/**
 * The error rate the paid console leads with, pinned against fixtures with a
 * known mix.
 *
 * It shipped reading 100.00% for an account that was 93% successful, on all
 * three windows at once, while the Requests tile beside it — same rows, same
 * window — read correctly. Neither symptom is visible to a type-checker, and
 * a chart draws "every request failed" exactly as willingly as the truth, so
 * the arithmetic is asserted here on numbers rather than looked at.
 */

/** The mix QA measured over 7 days: 566 + 32 + 12 = 610 requests, 44 of them
 *  failures — a 7.2% error rate reported as 100.00%. */
const QA_MIX = [
  { outcome: 'ok', count: 566 },
  { outcome: 'error', count: 32 },
  { outcome: 'rate_limited', count: 12 },
];

const QA_TOTAL = 610;
const QA_ERRORS = 44;

describe('summarizeOutcomes', () => {
  test('a 93%-successful account does not report a 100% error rate', () => {
    const summary = summarizeOutcomes(QA_MIX);
    expect(summary.totalRequests).toBe(QA_TOTAL);
    expect(summary.errors).toBe(QA_ERRORS);
    expect(summary.errorRate).toBeCloseTo(QA_ERRORS / QA_TOTAL, 10);
    expect(summary.errorRate * 100).toBeCloseTo(7.21, 2);
  });

  test('the error count is never the request count when any request succeeded', () => {
    // The chart's tell: the red series drawn at exactly the height of the blue
    // one, every single day.
    const summary = summarizeOutcomes(QA_MIX);
    expect(summary.errors).not.toBe(summary.totalRequests);
  });

  test('every failure outcome counts as an error', () => {
    for (const outcome of USAGE_FAILURE_OUTCOMES) {
      const summary = summarizeOutcomes([{ outcome, count: 3 }]);
      expect(summary.errors).toBe(3);
      expect(summary.errorRate).toBe(1);
    }
  });

  test('a clean window is 0%, not NaN', () => {
    expect(summarizeOutcomes([{ outcome: 'ok', count: 400 }]).errorRate).toBe(0);
  });

  test('an empty window is 0%, not a division by zero', () => {
    const summary = summarizeOutcomes([]);
    expect(summary.totalRequests).toBe(0);
    expect(summary.errorRate).toBe(0);
  });

  test('a total outage is still reported as one', () => {
    expect(summarizeOutcomes([{ outcome: 'error', count: 601 }]).errorRate).toBe(1);
  });

  test('an unrecognised outcome is counted as a request but not as an error', () => {
    // The regression itself: `!== 'ok'` made one unknown spelling — a legacy
    // row, a hand-seeded fixture, a writer that says `success` — mean "every
    // request failed". An allowlist can only ever undercount an unknown.
    const summary = summarizeOutcomes([
      { outcome: 'success', count: 566 },
      { outcome: 'error', count: 32 },
      { outcome: 'rate_limited', count: 12 },
    ]);
    expect(summary.totalRequests).toBe(QA_TOTAL);
    expect(summary.errors).toBe(QA_ERRORS);
    expect(summary.errorRate).toBeCloseTo(QA_ERRORS / QA_TOTAL, 10);
  });
});

describe('the outcome vocabulary', () => {
  test('success is not in the failure set', () => {
    expect(isUsageFailure(USAGE_SUCCESS_OUTCOME)).toBe(false);
  });

  test('the vocabulary is the success sentinel plus the failures, with no overlap', () => {
    expect([...USAGE_OUTCOMES]).toEqual([USAGE_SUCCESS_OUTCOME, ...USAGE_FAILURE_OUTCOMES]);
    expect(new Set(USAGE_OUTCOMES).size).toBe(USAGE_OUTCOMES.length);
  });

  test('an unknown value is not a failure', () => {
    expect(isUsageFailure('success')).toBe(false);
    expect(isUsageFailure('')).toBe(false);
    expect(isUsageFailure('OK')).toBe(false);
  });
});
