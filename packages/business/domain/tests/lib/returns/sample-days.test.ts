import { describe, expect, test } from 'bun:test';
import { sampleDays } from '../../../src/lib/returns/sample-days';

/**
 * SC-1297 — how many points the comparison chart asks prices for.
 *
 * Each sampled day costs one price conversion per benchmark, so the window's
 * length cannot be the point count. What must never be sampled away is either
 * END: the chart's last point is the number printed above it, and a chart
 * whose final point disagrees with the headline is the defect this whole card
 * exists to remove.
 */

const days = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  );

describe('sampleDays', () => {
  test('a short window is returned whole', () => {
    const input = days(30);
    expect(sampleDays(input, 120)).toEqual(input);
  });

  test('a long window is thinned to at most the cap', () => {
    const sampled = sampleDays(days(1000), 120);
    expect(sampled.length).toBeLessThanOrEqual(120);
    expect(sampled.length).toBeGreaterThan(60);
  });

  test('both ends survive, whatever the cap', () => {
    const input = days(1000);
    const sampled = sampleDays(input, 7);
    expect(sampled[0]).toBe(input[0]);
    expect(sampled[sampled.length - 1]).toBe(input[input.length - 1]);
  });

  test('the order is preserved and nothing repeats', () => {
    const sampled = sampleDays(days(365), 50);
    expect([...sampled].sort()).toEqual(sampled);
    expect(new Set(sampled).size).toBe(sampled.length);
  });

  test('an empty window samples to nothing rather than to a fabricated day', () => {
    expect(sampleDays([], 120)).toEqual([]);
  });

  test('one day is one point', () => {
    expect(sampleDays(['2026-01-01'], 120)).toEqual(['2026-01-01']);
  });
});
