import { describe, expect, test } from 'bun:test';
import { coldBootBalance, coldBootHolding } from '../lib/cold-boot-holding';

/**
 * `scripts/seed-cold-boot.ts` inserts its holdings directly, so nothing else
 * gives them a kind or a start (foundation A2, D-6). Asserted on the row
 * itself: a check that fills only NULL kinds cannot see a wrong one (R84).
 */
describe('the cold-boot harness holding', () => {
  test('is an unfunded snapshot holding that starts at its creation', () => {
    const at = new Date('2026-10-03T09:00:00.000Z');
    expect(
      coldBootHolding({ userId: 'user', accountId: 'account', tokenId: 'token', index: 3, at })
    ).toEqual({
      userId: 'user',
      accountId: 'account',
      tokenId: 'token',
      balance: '0',
      source: 'manual',
      kind: 'snapshot',
      createdAt: at,
      startsAt: at,
    });
  });

  // The calculator funds it from the person's reading (A5 D-4).
  test('is funded by the value a person records', () => {
    expect(coldBootBalance(3)).toBe('13');
  });
});
