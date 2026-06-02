import { describe, expect, test } from 'bun:test';
import {
  applyOverrides,
  confidenceOrder,
  groupOverridesByPeriod,
  type NeonUsage,
  priceNeonUsage,
  type SpendLineItem,
  type SpendOverride,
} from '../../../src/lib/clients/spend-pricing';

const GB = 1e9;

describe('priceNeonUsage', () => {
  test('reproduces invoice MYVQRL-00001 ($24.29) to the cent', () => {
    // Exact line quantities off the real Neon invoice (May 6–31, 2026,
    // Launch plan). Neon meters storage/egress in decimal GB (÷10⁹).
    const usage: NeonUsage = {
      projectId: 'sweet-river-35474549',
      plan: 'launch',
      computeUnitSeconds: 228.850278 * 3600,
      storageBytesMonth: 0.093552 * GB,
      snapshotBytesMonth: 0,
      instantRestoreBytesMonth: 0.006166 * GB,
      egressBytes: 25.569762 * GB,
    };
    expect(priceNeonUsage(usage).amountUsd).toBe(24.29);
  });

  test('egress under the 100 GB free allowance is not billed', () => {
    const usage: NeonUsage = {
      projectId: 'p',
      plan: 'launch',
      computeUnitSeconds: 0,
      storageBytesMonth: 0,
      snapshotBytesMonth: 0,
      instantRestoreBytesMonth: 0,
      egressBytes: 50 * GB,
    };
    expect(priceNeonUsage(usage).amountUsd).toBe(0);
  });

  test('Scale tier compute is priced higher than Launch', () => {
    const base: NeonUsage = {
      projectId: 'p',
      plan: 'launch',
      computeUnitSeconds: 100 * 3600,
      storageBytesMonth: 0,
      snapshotBytesMonth: 0,
      instantRestoreBytesMonth: 0,
      egressBytes: 0,
    };
    const launch = priceNeonUsage(base).amountUsd;
    const scale = priceNeonUsage({ ...base, plan: 'scale' }).amountUsd;
    expect(launch).toBeCloseTo(10.6, 5);
    expect(scale).toBeCloseTo(22.2, 5);
  });

  test('free tier prices compute at $0', () => {
    const usage: NeonUsage = {
      projectId: 'p',
      plan: 'free',
      computeUnitSeconds: 500 * 3600,
      storageBytesMonth: 0,
      snapshotBytesMonth: 0,
      instantRestoreBytesMonth: 0,
      egressBytes: 0,
    };
    expect(priceNeonUsage(usage).amountUsd).toBe(0);
  });
});

describe('applyOverrides', () => {
  const period = '2026-05';
  const estimate = (provider: SpendLineItem['provider'], amount: number): SpendLineItem => ({
    provider,
    label: `${provider} est`,
    amount,
    currency: 'USD',
    confidence: 'estimated',
    period,
  });

  test('replaces a provider estimate with the operator actual for that period', () => {
    const items = [estimate('neon', 19), estimate('upstash', 5)];
    const overrides: SpendOverride[] = [
      { provider: 'neon', period, amountUsd: 24.29, updatedAt: '2026-06-01T00:00:00Z' },
    ];
    const out = applyOverrides(items, overrides, period);
    const neon = out.filter((i) => i.provider === 'neon');
    expect(neon).toHaveLength(1);
    expect(neon[0]!.confidence).toBe('actual');
    expect(neon[0]!.amount).toBe(24.29);
    // Untouched providers survive.
    expect(out.find((i) => i.provider === 'upstash')?.confidence).toBe('estimated');
  });

  test('ignores overrides whose period does not match the displayed month', () => {
    const items = [estimate('neon', 19)];
    const overrides: SpendOverride[] = [
      { provider: 'neon', period: '2026-04', amountUsd: 30, updatedAt: '2026-05-01T00:00:00Z' },
    ];
    const out = applyOverrides(items, overrides, period);
    expect(out).toEqual(items);
  });

  test('collapses multiple estimate lines for one provider into a single actual', () => {
    const items = [estimate('neon', 10), estimate('neon', 9), estimate('fly', 8)];
    const overrides: SpendOverride[] = [
      { provider: 'neon', period, amountUsd: 24.29, updatedAt: '2026-06-01T00:00:00Z' },
    ];
    const out = applyOverrides(items, overrides, period);
    expect(out.filter((i) => i.provider === 'neon')).toHaveLength(1);
    expect(out.filter((i) => i.provider === 'fly')).toHaveLength(1);
  });
});

describe('groupOverridesByPeriod', () => {
  test('groups by month newest-first with a per-month total', () => {
    const overrides: SpendOverride[] = [
      { provider: 'neon', period: '2026-05', amountUsd: 24.29, updatedAt: 't' },
      { provider: 'upstash', period: '2026-05', amountUsd: 18.92, updatedAt: 't' },
      { provider: 'fly', period: '2026-05', amountUsd: 8.06, updatedAt: 't' },
      { provider: 'neon', period: '2026-04', amountUsd: 20, updatedAt: 't' },
    ];
    const groups = groupOverridesByPeriod(overrides);
    expect(groups.map((g) => g.period)).toEqual(['2026-05', '2026-04']);
    expect(groups[0]!.totalUsd).toBe(51.27);
    expect(groups[0]!.items.map((i) => i.provider)).toEqual(['fly', 'neon', 'upstash']);
    expect(groups[1]!.totalUsd).toBe(20);
  });

  test('returns an empty list when no overrides exist', () => {
    expect(groupOverridesByPeriod([])).toEqual([]);
  });
});

describe('confidenceOrder', () => {
  test('sorts actual before invoiced before estimated before unknown', () => {
    const sorted = (['unknown', 'estimated', 'actual', 'invoiced'] as const)
      .slice()
      .sort((a, b) => confidenceOrder(a) - confidenceOrder(b));
    expect(sorted).toEqual(['actual', 'invoiced', 'estimated', 'unknown']);
  });
});
