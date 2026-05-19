process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';

// Stubs leak across files because typedi's Container is process-global.
// After this suite, restore real @Service() instances so a later
// repo/service test that ran in the same `bun test` invocation can
// resolve the real DB-backed implementation.
afterAll(() => {
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(HoldingBalanceObservationRepository, new HoldingBalanceObservationRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(BalanceAtTimeService, new BalanceAtTimeService());
});

// Minimal in-memory stubs. Only the methods BalanceAtTimeService calls are
// implemented; anything else would throw if touched. Keeps the tests honest
// — a future refactor that adds a dep we don't stub will fail loudly here.

function makeObservationStub(
  rows: Array<{
    holdingId: string;
    balance: string;
    observedAt: Date;
  }>
): HoldingBalanceObservationRepository {
  return {
    findLatestAtOrAfter: async (holdingId: string, at: Date) => {
      const match = rows
        .filter((r) => r.holdingId === holdingId && r.observedAt >= at)
        .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())[0];
      return match
        ? ({
            ...match,
            id: 'x',
            userId: 'u',
            source: 's',
            sourceMetadata: {},
            createdAt: new Date(),
          } as never)
        : null;
    },
    findLatestAtOrBefore: async (holdingId: string, at: Date) => {
      const match = rows
        .filter((r) => r.holdingId === holdingId && r.observedAt <= at)
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
      return match
        ? ({
            ...match,
            id: 'x',
            userId: 'u',
            source: 's',
            sourceMetadata: {},
            createdAt: new Date(),
          } as never)
        : null;
    },
  } as unknown as HoldingBalanceObservationRepository;
}

function makeTransactionStub(
  rows: Array<{
    holdingId: string;
    quantity: string;
    occurredAt: Date;
    priceNative?: string;
    priceNativeTokenId?: string;
  }>
): HoldingTransactionRepository {
  return {
    findForHoldingInRange: async (holdingId: string, from: Date, to: Date) => {
      return rows
        .filter((r) => r.holdingId === holdingId && r.occurredAt > from && r.occurredAt <= to)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((r) => ({
          ...r,
          id: 'x',
          userId: 'u',
          tokenId: 'tok-1',
          kind: 'deposit',
          source: 's',
          sourceMetadata: {},
          rawPayload: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })) as never;
    },
  } as unknown as HoldingTransactionRepository;
}

function makeHoldingStub(
  holding: {
    id: string;
    userId: string;
    accountId: string;
    tokenId: string;
    balance: string;
    lastUpdated: Date;
  } | null
): HoldingRepository {
  return {
    // BaseRepository.findById; BalanceAtTimeService fetches the holding
    // directly by its PK now that transactions key on holdingId.
    findById: async () => (holding as never) ?? null,
  } as unknown as HoldingRepository;
}

// The service reads its deps from the typedi Container (class-field DI).
// The factory seeds stubs via `Container.set()` and then *constructs a
// fresh* BalanceAtTimeService so its class-field initializers capture
// the current stubs. We can't `Container.reset()` — that would also
// drop the @Service() registration that the decorator put in at
// module load time and can't be recreated without re-importing. We
// also can't `Container.remove(BalanceAtTimeService)` for the same
// reason. Overriding the stored instance with `Container.set` works.
function makeService(
  observations: Parameters<typeof makeObservationStub>[0],
  txs: Parameters<typeof makeTransactionStub>[0],
  holding: Parameters<typeof makeHoldingStub>[0] = null
): BalanceAtTimeService {
  Container.set(HoldingRepository, makeHoldingStub(holding));
  Container.set(HoldingBalanceObservationRepository, makeObservationStub(observations));
  Container.set(HoldingTransactionRepository, makeTransactionStub(txs));
  const instance = new BalanceAtTimeService();
  Container.set(BalanceAtTimeService, instance);
  return instance;
}

const HOLD = 'hold-1';

describe('BalanceAtTimeService.getBalance', () => {
  test('returns null when no data exists anywhere', async () => {
    const svc = makeService([], []);
    const r = await svc.getBalance(HOLD, new Date('2024-01-01T00:00:00Z'));
    expect(r.balance).toBeNull();
    expect(r.anchor).toBeNull();
    expect(r.anchorAt).toBeNull();
    expect(r.txApplied).toBe(0);
  });

  test('uses observation-after as anchor and walks backward over txs', async () => {
    // We have a future observation of 10 BTC at 2024-06-01.
    // Between 2024-03-01 (query) and 2024-06-01 there were three txs:
    //   +5 on 2024-04-01, -3 on 2024-05-01, +1 on 2024-05-15 = net +3.
    // Balance at 2024-03-01 must be 10 - 3 = 7.
    const svc = makeService(
      [{ holdingId: HOLD, balance: '10', observedAt: new Date('2024-06-01T00:00:00Z') }],
      [
        { holdingId: HOLD, quantity: '5', occurredAt: new Date('2024-04-01T00:00:00Z') },
        { holdingId: HOLD, quantity: '-3', occurredAt: new Date('2024-05-01T00:00:00Z') },
        { holdingId: HOLD, quantity: '1', occurredAt: new Date('2024-05-15T00:00:00Z') },
      ]
    );
    const r = await svc.getBalance(HOLD, new Date('2024-03-01T00:00:00Z'));
    expect(r.balance?.toString()).toBe('7');
    expect(r.anchor).toBe('observation-after');
    expect(r.txApplied).toBe(3);
  });

  test('uses holdings.balance fallback when no observation-after exists', async () => {
    // Current balance 20 at 2024-12-01. Query 2024-07-01. Two txs between:
    //   +5 at 2024-08-01, -2 at 2024-09-01 = net +3.
    // Balance at 2024-07-01 = 20 - 3 = 17.
    const svc = makeService(
      [], // no observation-after
      [
        { holdingId: HOLD, quantity: '5', occurredAt: new Date('2024-08-01T00:00:00Z') },
        { holdingId: HOLD, quantity: '-2', occurredAt: new Date('2024-09-01T00:00:00Z') },
      ],
      {
        id: HOLD,
        userId: 'u1',
        accountId: 'acc-1',
        tokenId: 'tok-1',
        balance: '20',
        lastUpdated: new Date('2024-12-01T00:00:00Z'),
      }
    );
    const r = await svc.getBalance(HOLD, new Date('2024-07-01T00:00:00Z'));
    expect(r.balance?.toString()).toBe('17');
    expect(r.anchor).toBe('holdings');
    expect(r.txApplied).toBe(2);
  });

  test('uses observation-before as last-ditch anchor, walking forward', async () => {
    // Observation at 2023-01-01 shows 2 ETH. Query 2023-06-01. Between them:
    //   +4 at 2023-03-01. Balance at query = 2 + 4 = 6.
    const svc = makeService(
      [{ holdingId: HOLD, balance: '2', observedAt: new Date('2023-01-01T00:00:00Z') }],
      [{ holdingId: HOLD, quantity: '4', occurredAt: new Date('2023-03-01T00:00:00Z') }]
    );
    const r = await svc.getBalance(HOLD, new Date('2023-06-01T00:00:00Z'));
    expect(r.balance?.toString()).toBe('6');
    expect(r.anchor).toBe('observation-before');
    expect(r.txApplied).toBe(1);
  });

  test('exact-match observation at query time returns balance with no walk', async () => {
    const svc = makeService(
      [{ holdingId: HOLD, balance: '42', observedAt: new Date('2024-01-01T00:00:00Z') }],
      []
    );
    const r = await svc.getBalance(HOLD, new Date('2024-01-01T00:00:00Z'));
    expect(r.balance?.toString()).toBe('42');
    expect(r.anchor).toBe('observation-after');
    expect(r.txApplied).toBe(0);
  });

  test('txs outside the (at, anchor] window are not applied', async () => {
    // Observation at 2024-06-01: 10. Query at 2024-05-01. Txs BEFORE query at
    // 2024-04-01 must not influence the walk; balance stays anchor (no txs
    // in-range).
    const svc = makeService(
      [{ holdingId: HOLD, balance: '10', observedAt: new Date('2024-06-01T00:00:00Z') }],
      [{ holdingId: HOLD, quantity: '99', occurredAt: new Date('2024-04-01T00:00:00Z') }]
    );
    const r = await svc.getBalance(HOLD, new Date('2024-05-01T00:00:00Z'));
    expect(r.balance?.toString()).toBe('10');
    expect(r.txApplied).toBe(0);
  });
});
