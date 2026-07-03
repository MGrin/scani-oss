import { describe, expect, it } from 'bun:test';
import { validateSpendOverridePayload } from '../../../src/presentation/http/admin-data';

describe('validateSpendOverridePayload', () => {
  it('accepts a well-formed payload and normalizes the amount', () => {
    const result = validateSpendOverridePayload({
      provider: 'fly',
      period: '2026-06',
      amountUsd: 52.719,
      note: '  EUIL2SB6-0002  ',
    });
    expect(result).toEqual({
      ok: true,
      value: { provider: 'fly', period: '2026-06', amountUsd: 52.72, note: 'EUIL2SB6-0002' },
    });
  });

  it('treats an empty note as absent', () => {
    const result = validateSpendOverridePayload({
      provider: 'neon',
      period: '2026-07',
      amountUsd: 10,
      note: '   ',
    });
    expect(result.ok && result.value.note).toBeUndefined();
  });

  it.each([
    ['null body', null],
    ['non-object body', 'fly'],
    ['missing provider', { period: '2026-06', amountUsd: 1 }],
    ['uppercase provider', { provider: 'Fly', period: '2026-06', amountUsd: 1 }],
    ['long provider', { provider: 'x'.repeat(33), period: '2026-06', amountUsd: 1 }],
    ['bad period', { provider: 'fly', period: '2026-13', amountUsd: 1 }],
    ['period without month', { provider: 'fly', period: '2026', amountUsd: 1 }],
    ['negative amount', { provider: 'fly', period: '2026-06', amountUsd: -1 }],
    ['NaN amount', { provider: 'fly', period: '2026-06', amountUsd: Number.NaN }],
    ['string amount', { provider: 'fly', period: '2026-06', amountUsd: '52' }],
    ['non-string note', { provider: 'fly', period: '2026-06', amountUsd: 1, note: 42 }],
  ])('rejects %s', (_label, input) => {
    expect(validateSpendOverridePayload(input).ok).toBe(false);
  });

  it('truncates oversized notes to 256 chars', () => {
    const result = validateSpendOverridePayload({
      provider: 'fly',
      period: '2026-06',
      amountUsd: 1,
      note: 'n'.repeat(400),
    });
    expect(result.ok && result.value.note?.length).toBe(256);
  });
});
