import { describe, expect, test } from 'bun:test';
import type { ExitedPosition, HoldingSnapshot } from '@scani/providers/core/types';
import { exitedPositionSnapshots } from '../../../src/use-cases/lib/exitedPositions';

const balance = (externalId: string, amount: string): HoldingSnapshot => ({
  externalId,
  balance: amount,
  capturedAt: new Date('2026-08-28T00:00:00.000Z'),
  tokenIdentity: { symbol: externalId.toUpperCase() },
});

const closed = (externalId: string): ExitedPosition => ({
  externalId,
  tokenIdentity: { symbol: externalId.toUpperCase() },
});

const AT = new Date('2026-08-28T01:00:00.000Z');

describe('what a wallet review offers beyond current balances (SC-398)', () => {
  // MUST-BE-FOUND. Without this the whole ticket is unobservable: a token
  // bought and fully exited before the first import has no balance, so it is
  // offered to nobody, gets no holding, and `TransactionRouter` then drops
  // BOTH its legs for want of one.
  test('a closed position is offered, anchored at zero', () => {
    const out = exitedPositionSnapshots({
      balances: [balance('0xusdc', '5')],
      exited: [closed('0xgala')],
      excludedKeys: new Set(),
      institutionId: 'eth',
      capturedAt: AT,
    });
    expect(out).toEqual([
      {
        externalId: '0xgala',
        tokenIdentity: { symbol: '0XGALA' },
        balance: '0',
        capturedAt: AT,
        tokenType: undefined,
      },
    ]);
  });

  // The second gate, and it is the one that is easy to leave out. PUNKS is
  // paid for, 107.59 of it is still in the wallet, it WAS shown at review and
  // the user did not keep it. Re-offering it PRE-TICKED — which is what
  // `initialWalletSelection` does to any row the spam heuristic does not flag
  // — would let a click-through import an answer somebody already gave.
  test('a token the user declined is not offered again', () => {
    const out = exitedPositionSnapshots({
      balances: [],
      exited: [closed('0xpunks'), closed('0xgala')],
      excludedKeys: new Set(['eth:0xpunks']),
      institutionId: 'eth',
      capturedAt: AT,
    });
    expect(out.map((s) => s.externalId)).toEqual(['0xgala']);
  });

  // The exclusion key carries the institution, so declining a token on one
  // chain says nothing about the same contract address on another. Without
  // this the first refusal would silence every chain at once.
  test('an exclusion on another chain does not silence this one', () => {
    const out = exitedPositionSnapshots({
      balances: [],
      exited: [closed('0xgala')],
      excludedKeys: new Set(['base:0xgala']),
      institutionId: 'eth',
      capturedAt: AT,
    });
    expect(out.map((s) => s.externalId)).toEqual(['0xgala']);
  });

  // The provider measures each of these at zero before returning it, so this
  // should never fire in practice. It is here because the two balance reads
  // happen at different moments and the failure is not cosmetic: two rows
  // under one `externalId` is a duplicate holding.
  test('a position that is still held is not offered a second time', () => {
    const out = exitedPositionSnapshots({
      balances: [balance('0xGALA', '3')],
      exited: [closed('0xgala')],
      excludedKeys: new Set(),
      institutionId: 'eth',
      capturedAt: AT,
    });
    expect(out).toEqual([]);
  });

  test('a provider repeating itself still produces one row', () => {
    const out = exitedPositionSnapshots({
      balances: [],
      exited: [closed('0xgala'), closed('0xGALA')],
      excludedKeys: new Set(),
      institutionId: 'eth',
      capturedAt: AT,
    });
    expect(out.map((s) => s.externalId)).toEqual(['0xgala']);
  });

  // MUST-BE-ABSENT for the whole feature: a wallet with nothing closed must
  // produce a payload identical to the one it produced before this existed.
  test('a wallet with no closed positions gains no rows', () => {
    expect(
      exitedPositionSnapshots({
        balances: [balance('0xusdc', '5')],
        exited: [],
        excludedKeys: new Set(),
        institutionId: 'eth',
        capturedAt: AT,
      })
    ).toEqual([]);
  });
});
