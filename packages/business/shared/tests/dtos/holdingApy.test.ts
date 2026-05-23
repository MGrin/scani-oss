import { describe, expect, test } from 'bun:test';
import { PayoutFrequency, UpsertHoldingApyConfigDto } from '../../src/dtos/holdingApy';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

const base = {
  holdingId: VALID_UUID,
  annualRatePct: '4.5',
};

describe('PayoutFrequency enum', () => {
  test('accepts every supported frequency', () => {
    for (const f of ['daily', 'weekdays', 'weekly', 'monthly', 'yearly']) {
      expect(PayoutFrequency.safeParse(f).success).toBe(true);
    }
  });

  test('rejects unknown frequencies', () => {
    expect(PayoutFrequency.safeParse('hourly').success).toBe(false);
  });
});

describe('UpsertHoldingApyConfigDto — annualRatePct', () => {
  test('accepts decimal between 0 (exclusive) and 100 (inclusive)', () => {
    expect(UpsertHoldingApyConfigDto.safeParse({ ...base, payoutFrequency: 'daily' }).success).toBe(
      true
    );
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        annualRatePct: '100',
        payoutFrequency: 'daily',
      }).success
    ).toBe(true);
  });

  test('rejects 0 and negative rates', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        annualRatePct: '0',
        payoutFrequency: 'daily',
      }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        annualRatePct: '-1',
        payoutFrequency: 'daily',
      }).success
    ).toBe(false);
  });

  test('rejects rates > 100', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        annualRatePct: '100.01',
        payoutFrequency: 'daily',
      }).success
    ).toBe(false);
  });

  test('rejects unparseable strings', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        annualRatePct: 'not-a-number',
        payoutFrequency: 'daily',
      }).success
    ).toBe(false);
  });
});

describe('UpsertHoldingApyConfigDto — payoutFrequency superRefine', () => {
  test('weekly requires payoutDayOfWeek', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({ ...base, payoutFrequency: 'weekly' }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'weekly',
        payoutDayOfWeek: 1,
      }).success
    ).toBe(true);
  });

  test('monthly requires payoutDayOfMonth', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({ ...base, payoutFrequency: 'monthly' }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'monthly',
        payoutDayOfMonth: 15,
      }).success
    ).toBe(true);
  });

  test('yearly requires both payoutDayOfMonth and payoutMonth', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'yearly',
        payoutDayOfMonth: 1,
      }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'yearly',
        payoutMonth: 6,
      }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'yearly',
        payoutDayOfMonth: 1,
        payoutMonth: 6,
      }).success
    ).toBe(true);
  });

  test('daily and weekdays accept no extra fields', () => {
    expect(UpsertHoldingApyConfigDto.safeParse({ ...base, payoutFrequency: 'daily' }).success).toBe(
      true
    );
    expect(
      UpsertHoldingApyConfigDto.safeParse({ ...base, payoutFrequency: 'weekdays' }).success
    ).toBe(true);
  });
});

describe('UpsertHoldingApyConfigDto — boundary values', () => {
  test('payoutDayOfWeek bounds: 0..6', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'weekly',
        payoutDayOfWeek: 0,
      }).success
    ).toBe(true);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'weekly',
        payoutDayOfWeek: 6,
      }).success
    ).toBe(true);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'weekly',
        payoutDayOfWeek: 7,
      }).success
    ).toBe(false);
  });

  test('payoutDayOfMonth bounds: 1..31', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'monthly',
        payoutDayOfMonth: 1,
      }).success
    ).toBe(true);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'monthly',
        payoutDayOfMonth: 31,
      }).success
    ).toBe(true);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'monthly',
        payoutDayOfMonth: 0,
      }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'monthly',
        payoutDayOfMonth: 32,
      }).success
    ).toBe(false);
  });

  test('payoutMonth bounds: 1..12', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'yearly',
        payoutDayOfMonth: 1,
        payoutMonth: 0,
      }).success
    ).toBe(false);
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        ...base,
        payoutFrequency: 'yearly',
        payoutDayOfMonth: 1,
        payoutMonth: 13,
      }).success
    ).toBe(false);
  });
});

describe('UpsertHoldingApyConfigDto — top-level shape', () => {
  test('rejects non-uuid holdingId', () => {
    expect(
      UpsertHoldingApyConfigDto.safeParse({
        holdingId: 'not-a-uuid',
        annualRatePct: '4.5',
        payoutFrequency: 'daily',
      }).success
    ).toBe(false);
  });
});
