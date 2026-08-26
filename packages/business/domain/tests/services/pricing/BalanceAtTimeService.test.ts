process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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
    findExtremesForHolding: async (holdingId: string) => {
      const times = rows
        .filter((r) => r.holdingId === holdingId)
        .map((r) => r.observedAt.getTime())
        .sort((a, b) => a - b);
      return times.length
        ? { first: new Date(times[0] as number), last: new Date(times[times.length - 1] as number) }
        : { first: null, last: null };
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
    findExtremesForHolding: async (holdingId: string) => {
      const times = rows
        .filter((r) => r.holdingId === holdingId)
        .map((r) => r.occurredAt.getTime())
        .sort((a, b) => a - b);
      return times.length
        ? { first: new Date(times[0] as number), last: new Date(times[times.length - 1] as number) }
        : { first: null, last: null };
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
    createdAt: Date;
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
    const r = await svc.getBalance(HOLD, new Date('2024-01-01T00:00:00Z'), undefined);
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
    const r = await svc.getBalance(HOLD, new Date('2024-03-01T00:00:00Z'), undefined);
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
        createdAt: new Date('2024-06-01T00:00:00Z'),
      }
    );
    const r = await svc.getBalance(HOLD, new Date('2024-07-01T00:00:00Z'), undefined);
    expect(r.balance?.toString()).toBe('17');
    expect(r.anchor).toBe('holdings');
    expect(r.txApplied).toBe(2);
    expect(r.beforeRecords).toBe(false);
  });

  test('uses observation-before as last-ditch anchor, walking forward', async () => {
    // Observation at 2023-01-01 shows 2 ETH. Query 2023-06-01. Between them:
    //   +4 at 2023-03-01. Balance at query = 2 + 4 = 6.
    const svc = makeService(
      [{ holdingId: HOLD, balance: '2', observedAt: new Date('2023-01-01T00:00:00Z') }],
      [{ holdingId: HOLD, quantity: '4', occurredAt: new Date('2023-03-01T00:00:00Z') }]
    );
    const r = await svc.getBalance(HOLD, new Date('2023-06-01T00:00:00Z'), undefined);
    expect(r.balance?.toString()).toBe('6');
    expect(r.anchor).toBe('observation-before');
    expect(r.txApplied).toBe(1);
  });

  test('exact-match observation at query time returns balance with no walk', async () => {
    const svc = makeService(
      [{ holdingId: HOLD, balance: '42', observedAt: new Date('2024-01-01T00:00:00Z') }],
      []
    );
    const r = await svc.getBalance(HOLD, new Date('2024-01-01T00:00:00Z'), undefined);
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
    const r = await svc.getBalance(HOLD, new Date('2024-05-01T00:00:00Z'), undefined);
    expect(r.balance?.toString()).toBe('10');
    expect(r.txApplied).toBe(0);
  });
});

// SC-252. The reconstruction had no lower bound: it answered for any past
// instant, including before the holding, the account or the user existed.
// Below the earliest evidence we hold, `current balance - sum(all known
// txs)` stops being a reconstruction and becomes the unexplained opening
// balance, asserted for all of time. The value is still returned — the
// history chart is built on propagating a balance backward and dropping it
// would empty the chart for a newly-onboarded user — but `beforeRecords`
// travels with it so no caller can present it as a measurement.
describe('BalanceAtTimeService.getBalance — the lower bound (SC-252)', () => {
  // Production numbers, from the ticket: an Airwallex USD holding whose
  // current balance is 0 and whose ledger holds one withdraw of -586.94.
  // 0 - (-586.94) = +586.94, reported for every date before the ledger
  // starts, and stored coverage_quality = 'full'.
  const SC252 = {
    holding: {
      id: HOLD,
      userId: 'u1',
      accountId: 'acc-1',
      tokenId: 'tok-1',
      balance: '0',
      lastUpdated: new Date('2026-08-01T00:00:00Z'),
      createdAt: new Date('2026-06-22T00:00:00Z'),
    },
    withdraw: {
      holdingId: HOLD,
      quantity: '-586.94',
      occurredAt: new Date('2026-07-23T00:00:00Z'),
    },
    phantomDate: new Date('2025-06-21T00:00:00Z'),
  };

  test('flags a pre-existence date as before-records via the holdings anchor', async () => {
    const svc = makeService([], [SC252.withdraw], SC252.holding);
    const r = await svc.getBalance(HOLD, SC252.phantomDate, undefined);
    // The value is deliberately unchanged — this bounds confidence, not the number.
    expect(r.balance?.toString()).toBe('586.94');
    expect(r.anchor).toBe('holdings');
    expect(r.beforeRecords).toBe(true);
  });

  // The case a bound on anchor 2 alone would miss. `findObservationAtOrAfter`
  // runs FIRST, so any holding carrying observations never reaches the
  // holdings anchor — and for a pre-existence date the earliest observation
  // is always "at or after", putting the whole ledger inside the walk and
  // producing the identical residue.
  test('flags a pre-existence date as before-records via the observation-after anchor', async () => {
    const svc = makeService(
      [{ holdingId: HOLD, balance: '0', observedAt: new Date('2026-08-01T00:00:00Z') }],
      [SC252.withdraw],
      SC252.holding
    );
    const r = await svc.getBalance(HOLD, SC252.phantomDate, undefined);
    expect(r.balance?.toString()).toBe('586.94');
    expect(r.anchor).toBe('observation-after');
    expect(r.beforeRecords).toBe(true);
  });

  test('a date at the earliest evidence is not before-records', async () => {
    const svc = makeService([], [SC252.withdraw], SC252.holding);
    const r = await svc.getBalance(HOLD, SC252.holding.createdAt, undefined);
    expect(r.beforeRecords).toBe(false);
  });

  // The bound is the EARLIEST of the three, so an imported wallet whose
  // ledger reaches back years is answered from its first transaction and
  // not from the day we happened to learn of it.
  test('a transaction older than the holding row extends the bound backward', async () => {
    const svc = makeService(
      [],
      [{ holdingId: HOLD, quantity: '5', occurredAt: new Date('2021-03-01T00:00:00Z') }],
      SC252.holding
    );
    const r = await svc.getBalance(HOLD, new Date('2022-01-01T00:00:00Z'), undefined);
    expect(r.beforeRecords).toBe(false);
  });

  test('no evidence of any kind stays an honest unknown', async () => {
    const svc = makeService([], []);
    const r = await svc.getBalance(HOLD, SC252.phantomDate, undefined);
    expect(r.balance).toBeNull();
    expect(r.beforeRecords).toBe(false);
  });
});

// ---------------------------------------------------------------------
// SC-475 fault B — interpolation across an unexplained observation gap.
// ---------------------------------------------------------------------

describe('BalanceAtTimeService.getBalance — interpolation across sparse observations', () => {
  test('THE DEFECT: ten weeks of unexplained drift used to land on one day', async () => {
    // Production, exactly: an Edge Capital USD holding with two observations
    // 71 days apart and no transaction between them. Anchoring on "the
    // observation at or after `at`" means the anchor rolls over the instant
    // the earlier observation falls into the past, so the balance fell
    // 19,575.27 in a single day and a chained daily return read a 22% loss
    // on cash — the −42.27% sub-period that carried an entire year.
    const first = new Date('2026-05-17T15:07:54.662Z');
    const second = new Date('2026-07-27T23:47:01.714Z');
    const svc = makeService(
      [
        { holdingId: HOLD, balance: '41749.85', observedAt: first },
        { holdingId: HOLD, balance: '22174.58', observedAt: second },
      ],
      []
    );

    const dayAfter = await svc.getBalance(HOLD, new Date('2026-05-17T23:59:59.999Z'), undefined);
    // Under the cliff this read 22174.58 — the whole 71 days of drift on
    // the first day. It is now a few hours' worth.
    expect(Number(dayAfter.balance?.toString())).toBeGreaterThan(41600);
    expect(dayAfter.interpolated).toBe(true);

    // Halfway across the gap is halfway down.
    const midpoint = new Date((first.getTime() + second.getTime()) / 2);
    expect(
      Number((await svc.getBalance(HOLD, midpoint, undefined)).balance?.toString())
    ).toBeCloseTo((41749.85 + 22174.58) / 2, 6);
  });

  test('both measurements are reproduced exactly — only the space between them moves', async () => {
    const first = new Date('2026-05-17T15:07:54.662Z');
    const second = new Date('2026-07-27T23:47:01.714Z');
    const svc = makeService(
      [
        { holdingId: HOLD, balance: '41749.85', observedAt: first },
        { holdingId: HOLD, balance: '22174.58', observedAt: second },
      ],
      []
    );

    const atFirst = await svc.getBalance(HOLD, first, undefined);
    expect(atFirst.balance?.toString()).toBe('41749.85');
    // `at` sits ON an observation, so there is nothing to draw a line across.
    expect(atFirst.interpolated).toBe(false);

    const atSecond = await svc.getBalance(HOLD, second, undefined);
    expect(atSecond.balance?.toString()).toBe('22174.58');
    expect(atSecond.interpolated).toBe(false);
  });

  test('a gap the transactions DO explain is untouched, and not flagged', async () => {
    // The common path, and the reason this is safe to turn on for everyone:
    // where the ledger accounts for the difference between two observations
    // there is no drift to spread, so the walk-back answer is returned
    // unchanged and `interpolated` stays false.
    const first = new Date('2026-01-01T00:00:00Z');
    const second = new Date('2026-03-01T00:00:00Z');
    const svc = makeService(
      [
        { holdingId: HOLD, balance: '100', observedAt: first },
        { holdingId: HOLD, balance: '150', observedAt: second },
      ],
      [{ holdingId: HOLD, quantity: '50', occurredAt: new Date('2026-02-01T00:00:00Z') }]
    );

    const before = await svc.getBalance(HOLD, new Date('2026-01-15T00:00:00Z'), undefined);
    expect(before.balance?.toString()).toBe('100');
    expect(before.interpolated).toBe(false);

    const after = await svc.getBalance(HOLD, new Date('2026-02-15T00:00:00Z'), undefined);
    expect(after.balance?.toString()).toBe('150');
    expect(after.interpolated).toBe(false);
  });

  test('drift and a transaction in the same gap: only the drift is spread', async () => {
    const first = new Date('2026-01-01T00:00:00Z');
    const second = new Date('2026-01-11T00:00:00Z');
    const svc = makeService(
      [
        { holdingId: HOLD, balance: '100', observedAt: first },
        { holdingId: HOLD, balance: '160', observedAt: second },
      ],
      // 50 of the 60 is explained; 10 is drift.
      [{ holdingId: HOLD, quantity: '50', occurredAt: new Date('2026-01-09T00:00:00Z') }]
    );

    // Day 5 of 10: half the drift has accrued, the transaction has not landed.
    const midpoint = await svc.getBalance(HOLD, new Date('2026-01-06T00:00:00Z'), undefined);
    expect(Number(midpoint.balance?.toString())).toBeCloseTo(105, 9);
    expect(midpoint.interpolated).toBe(true);
  });

  test('before the first observation nothing is interpolated', async () => {
    // There is no earlier measurement to draw a line from, so the walk-back
    // from the first observation stands — which is what makes the opening
    // balance visible at all.
    const first = new Date('2026-05-17T15:07:54.662Z');
    const svc = makeService([{ holdingId: HOLD, balance: '41749.85', observedAt: first }], []);
    const r = await svc.getBalance(HOLD, new Date('2026-01-01T00:00:00Z'), undefined);
    expect(r.balance?.toString()).toBe('41749.85');
    expect(r.interpolated).toBe(false);
  });
});
