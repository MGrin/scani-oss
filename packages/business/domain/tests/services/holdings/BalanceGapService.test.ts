import type { DatabaseTransaction } from '@scani/db';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, describe, expect, test } from 'bun:test';
import { setSharedRedis } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import type { BalanceGapCandidate } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { BalanceGapService } from '../../../src/services/holdings/BalanceGapService';
import { ManualBalanceEditService } from '../../../src/services/holdings/ManualBalanceEditService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes so
// no later test file resolves them (SC-448).
restoreContainerAfterAll();

const USER = 'user-1';
const BASE = 'usd-token';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function candidate(over: Partial<BalanceGapCandidate> = {}): BalanceGapCandidate {
  const to = over.to ?? new Date('2026-06-10T00:00:00Z');
  return {
    observationId: over.observationId ?? 'obs-1',
    holdingId: over.holdingId ?? 'holding-1',
    tokenId: over.tokenId ?? 'token-1',
    tokenSymbol: over.tokenSymbol ?? 'USD',
    tokenTypeCode: over.tokenTypeCode ?? 'fiat',
    accountName: over.accountName ?? 'Revolut Savings',
    from: over.from ?? new Date(to.getTime() - DAY),
    to,
    previousBalance: over.previousBalance ?? '10000',
    balance: over.balance ?? '11000',
    explained: over.explained ?? '0',
    transactionsApplied: over.transactionsApplied ?? 0,
    source: over.source ?? 'sync-capture',
    gapReview: over.gapReview ?? null,
  };
}

interface Recorded {
  previousBalance: string;
  newBalance: string;
  cause: string;
  occurredAt: Date;
  editedAt: Date;
}

interface Stamped {
  observationId: string;
  answer: string | null;
  source: string | null;
}

const LOOKUP = { prefetched: true };
let lookups: unknown[][] = [];
let conversions: unknown[] = [];
// What the price rows look like to the stubbed graph: the fingerprint the
// cache keys on, and the rate every conversion applies.
let priceVersion = 'prices-v1';
let rate = new Decimal(1);

function seed(candidates: BalanceGapCandidate[]): {
  service: BalanceGapService;
  recorded: Recorded[];
  stamped: Stamped[];
} {
  const recorded: Recorded[] = [];
  const stamped: Stamped[] = [];
  lookups = [];
  conversions = [];
  priceVersion = 'prices-v1';
  rate = new Decimal(1);

  Container.set(HoldingBalanceObservationRepository, {
    findGapCandidatesForUser: async () => candidates,
    lockForGapAnswer: async (id: string) =>
      candidates.find((row) => row.observationId === id) ?? null,
    setGapReview: async (args: {
      observationId: string;
      answer: string | null;
      source: string | null;
    }) => {
      stamped.push({
        observationId: args.observationId,
        answer: args.answer,
        source: args.source,
      });
      return { id: args.observationId } as never;
    },
  } as unknown as HoldingBalanceObservationRepository);

  Container.set(HoldingRepository, {
    findById: async (id: string) =>
      ({ id, userId: USER, tokenId: 'token-1', lastUpdated: new Date() }) as never,
  } as unknown as HoldingRepository);

  Container.set(UserRepository, {
    findById: async () => ({ id: USER, baseCurrencyId: BASE }) as never,
  } as unknown as UserRepository);

  Container.set(TokenRepository, {
    findById: async () => ({ id: BASE, symbol: 'USD' }) as never,
  } as unknown as TokenRepository);

  // One unit of any token is worth one unit of base, so the priced threshold
  // is the quantity — which keeps every fixture below readable while still
  // going through the real conversion call.
  Container.set(PriceGraphService, {
    buildPriceLookup: async (...args: unknown[]) => {
      lookups.push(args);
      return LOOKUP;
    },
    priceLookupFingerprint: async () => priceVersion,
    convert: async (amount: Decimal, ...rest: unknown[]) => {
      conversions.push(rest[3]);
      return {
        amount: new Decimal(amount).mul(rate),
        rate,
        effectiveAt: new Date(),
        path: 'identity',
        stale: false,
      };
    },
  } as unknown as PriceGraphService);

  Container.set(ManualBalanceEditService, {
    record: async (input: Recorded) => {
      recorded.push(input);
      const delta = new Decimal(input.newBalance).sub(new Decimal(input.previousBalance));
      if (input.cause === 'growth') {
        return { cause: input.cause, delta, kind: null, occurredAt: null, skipped: null } as never;
      }
      return {
        cause: input.cause,
        delta,
        kind:
          input.cause === 'correction' ? 'correction' : delta.isPositive() ? 'deposit' : 'withdraw',
        occurredAt: input.occurredAt,
        skipped: null,
      } as never;
    },
  } as unknown as ManualBalanceEditService);

  const service = new BalanceGapService();
  const originalAnswer = service.answer.bind(service);
  const transaction = {
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as DatabaseTransaction;
  service.answer = (userId, input, now) => originalAnswer(userId, input, now, transaction);
  Container.set(BalanceGapService, service);
  return { service, recorded, stamped };
}

describe('BalanceGapService.listPending', () => {
  test('a plain unexplained change above the threshold is asked about', async () => {
    const { service } = seed([candidate()]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]?.drift).toBe('1000');
    expect(listing.items[0]?.baseValue).toBe('1000');
    expect(listing.examined).toBe(1);
  });

  test('a change under the threshold is suppressed AND counted', async () => {
    const { service } = seed([candidate({ balance: '10100' })]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(0);
    expect(listing.suppressed['below-threshold']).toBe(1);
    // The count is the whole point: a queue that drops rows and reports only
    // what survived cannot be told apart from a query that missed them.
    expect(listing.examined).toBe(1);
  });

  test('an observation the owner wrote is not asked about', async () => {
    const { service } = seed([candidate({ source: 'manual-edit-backfill' })]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(0);
    expect(listing.suppressed['owner-stated']).toBe(1);
  });

  test('a drift the next interval takes straight back is suppressed on BOTH sides', async () => {
    const first = candidate({
      observationId: 'obs-a',
      to: new Date('2026-07-21T00:00:00Z'),
      previousBalance: '61.28',
      balance: '234.13',
    });
    const second = candidate({
      observationId: 'obs-b',
      from: new Date('2026-07-21T00:00:00Z'),
      to: new Date('2026-08-05T00:00:00Z'),
      previousBalance: '234.13',
      balance: '61.28',
    });
    const { service } = seed([first, second]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(0);
    expect(listing.suppressed.reversed).toBe(2);
  });

  test('the reversal rule does NOT fire on two real movements of the same size', async () => {
    // The test to delete last. A rule that only ever fires is
    // indistinguishable from a broken one, and this is the case a future
    // reader will want to relax into a tolerance — at which point a genuine
    // 1,000 in followed by a genuine 1,000 out disappears from the queue.
    // These two are equal and opposite to the cent and are NOT suppressed,
    // because a transaction in the second interval says the ledger knows
    // something about the move.
    const first = candidate({
      observationId: 'obs-a',
      to: new Date('2026-07-21T00:00:00Z'),
      previousBalance: '0',
      balance: '1000',
    });
    const second = candidate({
      observationId: 'obs-b',
      from: new Date('2026-07-21T00:00:00Z'),
      to: new Date('2026-08-05T00:00:00Z'),
      previousBalance: '1000',
      balance: '0',
      explained: '-1',
      transactionsApplied: 1,
    });
    const { service } = seed([first, second]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(2);
    expect(listing.suppressed.reversed).toBe(0);
  });

  test('a reversal across two DIFFERENT holdings is not a reversal', async () => {
    const first = candidate({ observationId: 'obs-a', holdingId: 'h-1', balance: '11000' });
    const second = candidate({
      observationId: 'obs-b',
      holdingId: 'h-2',
      previousBalance: '11000',
      balance: '10000',
    });
    const { service } = seed([first, second]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(2);
    expect(listing.suppressed.reversed).toBe(0);
  });

  test('an already-answered gap leaves the queue without being counted as suppressed', async () => {
    const { service } = seed([candidate({ gapReview: 'flow' })]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(0);
    // Answered is not suppressed: it left because somebody dealt with it,
    // which is the queue working rather than a rule hiding something.
    expect(Object.values(listing.suppressed).every((n) => n === 0)).toBe(true);
    expect(listing.examined).toBe(1);
  });

  test('a change no price can reach is suppressed as unpriceable, not as small', async () => {
    seed([candidate()]);
    // Re-stubbed AFTER `seed`, then a fresh instance so the class-field DI
    // picks the refusing converter up — the pattern the DI note in CLAUDE.md
    // describes, applied to a stub that has to differ from the default.
    Container.set(PriceGraphService, {
      buildPriceLookup: async () => LOOKUP,
      priceLookupFingerprint: async () => priceVersion,
      convert: async () => null,
    } as unknown as PriceGraphService);
    const listing = await new BalanceGapService().listPending(USER);
    expect(listing.items).toHaveLength(0);
    // "We could not find out" resolves to its own name, never to the
    // convenient one — a gap worth 40,000 that we failed to price must not
    // land in the same bucket as one genuinely worth two dollars.
    expect(listing.suppressed.unpriceable).toBe(1);
    expect(listing.suppressed['below-threshold']).toBe(0);
  });

  test('every conversion shares ONE price prefetch spanning the candidates', async () => {
    const early = new Date('2026-03-01T00:00:00Z');
    const late = new Date('2026-06-10T00:00:00Z');
    const { service } = seed([
      candidate({ observationId: 'a', holdingId: 'h1', tokenId: 'btc', to: early }),
      candidate({ observationId: 'b', holdingId: 'h2', tokenId: 'eth', to: late }),
      candidate({ observationId: 'c', holdingId: 'h3', tokenId: 'btc', to: late }),
    ]);
    await service.listPending(USER);

    expect(lookups).toHaveLength(1);
    const [tokenIds, base, until, , since] = lookups[0] as [string[], string, Date, unknown, Date];
    expect(new Set(tokenIds)).toEqual(new Set(['btc', 'eth']));
    expect(base).toBe(BASE);
    expect(since).toEqual(early);
    expect(until).toEqual(late);
    expect(conversions).toHaveLength(3);
    for (const options of conversions) {
      expect((options as { priceLookup?: unknown }).priceLookup).toBe(LOOKUP);
    }
  });

  test('no prefetch when nothing reaches the pricing step', async () => {
    const { service } = seed([candidate({ source: 'manual' })]);
    await service.listPending(USER);
    expect(lookups).toHaveLength(0);
    expect(conversions).toHaveLength(0);
  });

  test('there is no age gate — a change observed one second ago is still asked about', async () => {
    const now = new Date();
    const { service } = seed([candidate({ from: new Date(now.getTime() - HOUR), to: now })]);
    const listing = await service.listPending(USER);
    expect(listing.items).toHaveLength(1);
  });

  test('a short interval is not asked to supply a date; a wide one is', async () => {
    const short = candidate({
      observationId: 'obs-short',
      from: new Date('2026-06-09T13:01:00Z'),
      to: new Date('2026-06-09T14:01:00Z'),
    });
    const wide = candidate({
      observationId: 'obs-wide',
      holdingId: 'holding-2',
      from: new Date('2026-05-17T00:00:00Z'),
      to: new Date('2026-07-27T00:00:00Z'),
    });
    const { service } = seed([short, wide]);
    const listing = await service.listPending(USER);
    const byId = new Map(listing.items.map((i) => [i.observationId, i]));
    expect(byId.get('obs-short')?.datePrompted).toBe(false);
    expect(byId.get('obs-wide')?.datePrompted).toBe(true);
  });

  test('the list is ordered by what it is worth, largest first', async () => {
    const small = candidate({ observationId: 'obs-small', balance: '10500' });
    const large = candidate({
      observationId: 'obs-large',
      holdingId: 'holding-2',
      balance: '30000',
    });
    const { service } = seed([small, large]);
    const listing = await service.listPending(USER);
    expect(listing.items.map((i) => i.observationId)).toEqual(['obs-large', 'obs-small']);
  });
});

describe('BalanceGapService.listPending cache (SC-1369)', () => {
  function fakeRedis(failGet = false) {
    const store = new Map<string, string>();
    setSharedRedis({
      get: async (key: string) => {
        if (failGet) throw new Error('redis down');
        return store.get(key) ?? null;
      },
      set: async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      },
    } as unknown as Parameters<typeof setSharedRedis>[0]);
    return store;
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => setSharedRedis(null));

  test('an unchanged candidate set is served without pricing, byte-identical', async () => {
    fakeRedis();
    const { service } = seed([
      candidate({ observationId: 'a', holdingId: 'h1', balance: '11000' }),
      candidate({ observationId: 'b', holdingId: 'h2', balance: '10001' }),
    ]);
    const first = await service.listPending(USER);
    await flush();
    lookups = [];
    conversions = [];

    const second = await service.listPending(USER);

    expect(lookups).toHaveLength(0);
    expect(conversions).toHaveLength(0);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('an answered gap changes the key, so the listing is priced again', async () => {
    fakeRedis();
    const candidates = [candidate({ observationId: 'a' })];
    const { service } = seed(candidates);
    expect((await service.listPending(USER)).items).toHaveLength(1);
    await flush();

    candidates[0] = candidate({ observationId: 'a', gapReview: 'growth' });
    lookups = [];
    conversions = [];

    expect((await service.listPending(USER)).items).toHaveLength(0);
    expect(conversions).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  test('a new observation changes the key, so the listing is priced again', async () => {
    fakeRedis();
    const candidates = [candidate({ observationId: 'a' })];
    const { service } = seed(candidates);
    await service.listPending(USER);
    await flush();

    candidates.push(candidate({ observationId: 'b', holdingId: 'h2' }));
    lookups = [];

    expect((await service.listPending(USER)).items).toHaveLength(2);
    expect(lookups).toHaveLength(1);
  });

  test('a failing Redis read degrades to computing, never to an error', async () => {
    fakeRedis(true);
    const { service } = seed([candidate()]);
    expect((await service.listPending(USER)).items).toHaveLength(1);
    expect(lookups).toHaveLength(1);
  });

  const ids = async (service: BalanceGapService) =>
    (await service.listPending(USER)).items.map((item) => item.observationId);

  test('a gap answered and then reopened is served gone, then back', async () => {
    fakeRedis();
    const candidates = [candidate({ observationId: 'a' })];
    const { service } = seed(candidates);
    expect(await ids(service)).toEqual(['a']);
    await flush();

    candidates[0] = candidate({ observationId: 'a', gapReview: 'growth' });
    expect(await ids(service)).toEqual([]);
    await flush();

    candidates[0] = candidate({ observationId: 'a', gapReview: null });
    expect(await ids(service)).toEqual(['a']);
  });

  test('a transaction that explains the gap is served as no gap', async () => {
    fakeRedis();
    const candidates = [candidate({ observationId: 'a' })];
    const { service } = seed(candidates);
    expect(await ids(service)).toEqual(['a']);
    await flush();

    candidates[0] = candidate({ observationId: 'a', explained: '1000', transactionsApplied: 1 });
    expect(await ids(service)).toEqual([]);
  });

  test('a price that lands is served at the new value', async () => {
    fakeRedis();
    const { service } = seed([candidate({ observationId: 'a' })]);
    const first = await service.listPending(USER);
    expect(first.items.map((i) => i.baseValue)).toEqual(['1000']);
    await flush();

    rate = new Decimal(3);
    priceVersion = 'prices-v2';
    const second = await service.listPending(USER);
    expect(second.items.map((i) => i.baseValue)).toEqual(['3000']);
    await flush();

    // And one that drops it under the threshold takes it off the queue.
    rate = new Decimal('0.000001');
    priceVersion = 'prices-v3';
    expect(await ids(service)).toEqual([]);
  });

  test('the price fingerprint is what carries a price change — the control', async () => {
    fakeRedis();
    const { service } = seed([candidate({ observationId: 'a' })]);
    await service.listPending(USER);
    await flush();
    rate = new Decimal(3);
    // Same fingerprint: the cache has no way to know, so it serves the old value.
    expect((await service.listPending(USER)).items.map((i) => i.baseValue)).toEqual(['1000']);
  });
});

describe('BalanceGapService.answer', () => {
  test('flow writes a deposit for the DRIFT, not for the whole balance change', async () => {
    // A transaction the ledger already holds explains its own part of the
    // move; restating that part would double it.
    const { service, recorded } = seed([
      candidate({
        previousBalance: '10000',
        balance: '13000',
        explained: '1000',
        transactionsApplied: 1,
      }),
    ]);
    const outcome = await service.answer(USER, {
      observationId: 'obs-1',
      answer: 'flow',
      occurredAt: new Date('2026-06-09T12:00:00Z'),
    });
    expect('result' in outcome).toBe(true);
    expect(recorded).toHaveLength(1);
    const delta = new Decimal(recorded[0]?.newBalance ?? '0').sub(
      new Decimal(recorded[0]?.previousBalance ?? '0')
    );
    expect(delta.toString()).toBe('2000');
  });

  test('a date before the interval is CLAMPED into it, not refused', async () => {
    const from = new Date('2026-06-09T13:01:00Z');
    const to = new Date('2026-06-09T14:01:00Z');
    const { service, recorded } = seed([candidate({ from, to })]);
    const outcome = await service.answer(USER, {
      observationId: 'obs-1',
      answer: 'flow',
      occurredAt: new Date('2026-06-08T16:00:00Z'),
    });
    expect('result' in outcome).toBe(true);
    // Strictly after `from`: a transaction stamped ON the earlier observation
    // falls outside `(from, to]` and the walk would never apply it.
    expect(recorded[0]?.occurredAt.getTime()).toBe(from.getTime() + 1);
    if ('result' in outcome) {
      // The clamp is reported rather than silent.
      expect(outcome.result.occurredAt).toBe(new Date(from.getTime() + 1).toISOString());
    }
  });

  test('a date after the interval is clamped to its close', async () => {
    const to = new Date('2026-06-10T00:00:00Z');
    const { service, recorded } = seed([candidate({ to })]);
    await service.answer(USER, {
      observationId: 'obs-1',
      answer: 'flow',
      occurredAt: new Date('2026-08-22T00:00:00Z'),
    });
    expect(recorded[0]?.occurredAt.getTime()).toBe(to.getTime());
  });

  test('a date inside the interval is used exactly as given', async () => {
    const at = new Date('2026-06-09T18:30:00Z');
    const { service, recorded } = seed([
      candidate({ from: new Date('2026-06-09T00:00:00Z'), to: new Date('2026-06-10T00:00:00Z') }),
    ]);
    await service.answer(USER, { observationId: 'obs-1', answer: 'flow', occurredAt: at });
    expect(recorded[0]?.occurredAt.getTime()).toBe(at.getTime());
  });

  test('growth stamps the review and writes no ledger row', async () => {
    const { service, recorded, stamped } = seed([candidate()]);
    const outcome = await service.answer(USER, { observationId: 'obs-1', answer: 'growth' });
    expect('result' in outcome && outcome.result.wroteKind).toBeNull();
    // `growth` still reaches the writer — which deliberately writes nothing —
    // so the three causes keep exactly one implementation between them.
    expect(recorded).toHaveLength(1);
    expect(stamped[0]?.answer).toBe('growth');
  });

  test('unknown stamps the review, writes nothing, and never reaches the writer', async () => {
    const { service, recorded, stamped } = seed([candidate()]);
    const outcome = await service.answer(USER, { observationId: 'obs-1', answer: 'unknown' });
    expect('result' in outcome && outcome.result.wroteKind).toBeNull();
    expect(recorded).toHaveLength(0);
    expect(stamped[0]).toEqual({ observationId: 'obs-1', answer: 'unknown', source: 'user' });
  });

  test('a gap already answered is refused rather than answered twice', async () => {
    const { service } = seed([candidate({ gapReview: 'unknown' })]);
    const outcome = await service.answer(USER, { observationId: 'obs-1', answer: 'flow' });
    expect(outcome).toEqual({ refusal: 'already-answered' });
  });

  test('a gap a transaction has since explained is refused, not booked twice', async () => {
    // The race the whole re-derivation exists for: the queue page can be
    // minutes old, and an import landing in between would otherwise get a
    // second copy of the same movement written on top of it.
    const { service, recorded } = seed([
      candidate({
        previousBalance: '10000',
        balance: '11000',
        explained: '1000',
        transactionsApplied: 1,
      }),
    ]);
    const outcome = await service.answer(USER, { observationId: 'obs-1', answer: 'flow' });
    expect(outcome).toEqual({ refusal: 'no-longer-a-gap' });
    expect(recorded).toHaveLength(0);
  });

  test('an observation that is not in the candidate set at all is refused', async () => {
    const { service } = seed([candidate()]);
    const outcome = await service.answer(USER, { observationId: 'obs-missing', answer: 'unknown' });
    expect(outcome).toEqual({ refusal: 'no-longer-a-gap' });
  });
});
