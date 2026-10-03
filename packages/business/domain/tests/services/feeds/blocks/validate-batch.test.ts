import { describe, expect, test } from 'bun:test';
import { validateBatch } from '../../../../src/services/feeds/blocks/validate-batch';
import type {
  AssetRef,
  FeedBatch,
  FeedCheckpoint,
  FeedEntry,
} from '../../../../src/services/feeds/feed-batch';

const at = (iso: string) => new Date(iso);

const FROM = at('2026-06-01T00:00:00Z');
const TO = at('2026-06-30T00:00:00Z');
const NOW = at('2026-07-15T00:00:00Z');

const USD: AssetRef = {
  identity: { symbol: 'USD', name: 'US Dollar' },
  typeCode: 'fiat',
  lookup: 'catalog-symbol',
};

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    externalId: 'row-1',
    asset: USD,
    amount: '10',
    occurredAt: at('2026-06-10T00:00:00Z'),
    legacy: { kind: 'deposit', source: 'statement-csv' },
    ...over,
  };
}

function checkpoint(over: Partial<FeedCheckpoint> = {}): FeedCheckpoint {
  return {
    asset: USD,
    at: TO,
    amount: '110',
    authority: 'statement',
    legacySource: 'statement-close',
    ...over,
  };
}

function batch(over: Partial<FeedBatch> = {}): FeedBatch {
  return {
    userId: 'user-1',
    input: {
      accountId: 'account-1',
      source: 'statement-import',
      credentialId: null,
      walletId: null,
    },
    fetchedAt: NOW,
    window: { from: FROM, to: TO, complete: false, uploadRef: 'upload-1' },
    checkpoints: [checkpoint()],
    entries: [entry()],
    absences: [],
    legacy: {
      holdingMatch: 'account-token',
      holdingPolicy: 'create',
      holdingSource: 'statement-import',
      arrival: 'user_confirmed',
      writesCache: true,
      createdWithoutCheckpoint: 'sum-of-entries',
      cacheObservation: null,
      derivesTradeLegs: false,
      holdingFailure: 'fail-batch',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unhideOnNonZero: false,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
    ...over,
  };
}

const codes = (b: FeedBatch, now: Date = NOW) => validateBatch(b, now).map((p) => p.code);

describe('validateBatch', () => {
  test('a valid batch returns no problem', () => {
    expect(validateBatch(batch(), NOW)).toEqual([]);
  });

  test('a batch with no entry and no checkpoint is valid', () => {
    expect(validateBatch(batch({ entries: [], checkpoints: [] }), NOW)).toEqual([]);
  });

  test('an entry with an empty external id is refused', () => {
    const problems = validateBatch(batch({ entries: [entry({ externalId: '' })] }), NOW);
    expect(problems.map((p) => p.code)).toEqual(['empty-external-id']);
    expect(problems[0]?.detail).toContain('USD');
  });

  test('a checkpoint after the window end is outside the window', () => {
    const late = checkpoint({ at: new Date(TO.getTime() + 1) });
    expect(codes(batch({ checkpoints: [late] }))).toEqual(['checkpoint-outside-window']);
  });

  test('a checkpoint before the window start is outside the window', () => {
    const early = checkpoint({ at: new Date(FROM.getTime() - 1) });
    expect(codes(batch({ checkpoints: [early] }))).toEqual(['checkpoint-outside-window']);
  });

  test('a checkpoint at exactly window.to is valid', () => {
    expect(codes(batch({ checkpoints: [checkpoint({ at: TO })] }))).toEqual([]);
  });

  test('a checkpoint at exactly window.from is valid', () => {
    expect(codes(batch({ checkpoints: [checkpoint({ at: FROM })] }))).toEqual([]);
  });

  test('an open-start window has no lower bound for a checkpoint to fall below', () => {
    const window = { from: null, to: TO, complete: true };
    const old = checkpoint({ at: at('1999-01-01T00:00:00Z') });
    expect(codes(batch({ window, checkpoints: [old] }))).toEqual([]);
  });

  test('an incomplete window with no start is unbounded', () => {
    const window = { from: null, to: TO, complete: false };
    expect(codes(batch({ window, checkpoints: [] }))).toEqual(['unbounded-incomplete-window']);
  });

  test('from null with complete true is valid', () => {
    const window = { from: null, to: TO, complete: true };
    expect(codes(batch({ window }))).toEqual([]);
  });

  test('a window that ends before it starts is inverted', () => {
    const window = { from: TO, to: FROM, complete: false };
    expect(codes(batch({ window, checkpoints: [] }))).toEqual(['window-inverted']);
  });

  test('a window of one instant is not inverted', () => {
    const window = { from: TO, to: TO, complete: false };
    expect(codes(batch({ window }))).toEqual([]);
  });

  test("a provider's checkpoint after now is in the future", () => {
    const future = checkpoint({ authority: 'provider', at: new Date(NOW.getTime() + 1) });
    const window = { from: FROM, to: at('2026-08-01T00:00:00Z'), complete: false };
    expect(codes(batch({ window, checkpoints: [future] }))).toEqual(['checkpoint-in-future']);
  });

  // A statement prints a day, or a local time with no zone, and it is read as
  // UTC: east of UTC the close of a fresh export sits after the moment it is
  // imported, and the import has always kept it as printed (ruling R22).
  test("a statement's checkpoint after now is kept, however far ahead it is printed", () => {
    const window = { from: FROM, to: at('2027-01-01T00:00:00Z'), complete: false };
    const after = (ms: number) =>
      codes(
        batch({
          window,
          checkpoints: [checkpoint({ authority: 'statement', at: new Date(NOW.getTime() + ms) })],
        })
      );
    expect([after(1), after(2 * 3_600_000), after(30 * 86_400_000)]).toEqual([[], [], []]);
  });

  test("a statement's checkpoint is still held to its window", () => {
    const future = checkpoint({ authority: 'statement', at: new Date(NOW.getTime() + 1) });
    expect(codes(batch({ checkpoints: [future] }))).toEqual(['checkpoint-outside-window']);
  });

  test('a checkpoint at exactly now is not in the future', () => {
    const window = { from: FROM, to: at('2026-08-01T00:00:00Z'), complete: false };
    expect(codes(batch({ window, checkpoints: [checkpoint({ at: NOW })] }))).toEqual([]);
  });

  test('the same checkpoint can break two rules and each is reported', () => {
    const future = checkpoint({ authority: 'provider', at: new Date(NOW.getTime() + 1) });
    expect(codes(batch({ checkpoints: [future] })).sort()).toEqual([
      'checkpoint-in-future',
      'checkpoint-outside-window',
    ]);
  });

  test('every offending row is reported, not only the first', () => {
    const problems = validateBatch(
      batch({
        entries: [
          entry({ externalId: '' }),
          entry({ externalId: 'ok' }),
          entry({ externalId: '' }),
        ],
        checkpoints: [
          checkpoint({ at: new Date(TO.getTime() + 1) }),
          checkpoint({ at: new Date(TO.getTime() + 2) }),
        ],
      }),
      NOW
    );
    expect(problems.map((p) => p.code)).toEqual([
      'empty-external-id',
      'empty-external-id',
      'checkpoint-outside-window',
      'checkpoint-outside-window',
    ]);
    expect(new Set(problems.map((p) => p.detail)).size).toBe(4);
  });

  test('an invalid date does not make it throw', () => {
    const broken = checkpoint({ at: new Date(Number.NaN) });
    expect(() => validateBatch(batch({ checkpoints: [broken] }), NOW)).not.toThrow();
  });

  // Every comparison with NaN is false, so without this rule an invalid date
  // breaks no other rule and the batch reads as clean.
  test('an invalid date is refused wherever it sits, and only as that', () => {
    const invalid = new Date(Number.NaN);
    const problems = validateBatch(
      batch({
        fetchedAt: invalid,
        window: { from: invalid, to: invalid, complete: false },
        checkpoints: [checkpoint({ at: invalid })],
        entries: [entry(), entry({ externalId: 'row-2', occurredAt: invalid })],
      }),
      NOW
    );
    expect(problems).toEqual([
      { code: 'invalid-date', detail: 'the batch was fetched at an invalid date' },
      { code: 'invalid-date', detail: 'entry 1 (USD) occurred at an invalid date' },
      { code: 'invalid-date', detail: 'the window starts at an invalid date' },
      { code: 'invalid-date', detail: 'the window ends at an invalid date' },
      { code: 'invalid-date', detail: 'checkpoint 0 (USD) is at an invalid date' },
    ]);
  });

  // Ingest writes absences now (A2 Task 14), so R30's refusal is gone.
  test('a batch carrying an absence is valid', () => {
    const absences = [{ asset: USD, confirmedAt: TO }];
    expect(validateBatch(batch({ absences }), NOW)).toEqual([]);
  });

  test('a leg settles an entry of its own batch, of its own source, that is not itself a leg', () => {
    const trade = entry({ externalId: 't1', legacy: { kind: 'buy', source: 'ibkr-api' } });
    const leg = (over: Partial<FeedEntry>) =>
      entry({
        externalId: 't1:fee',
        settlesExternalId: 't1',
        legacy: { kind: 'fee', source: 'ibkr-api' },
        ...over,
      });

    expect(codes(batch({ entries: [trade, leg({})] }))).toEqual([]);
    expect(validateBatch(batch({ entries: [leg({})] }), NOW)).toEqual([
      {
        code: 'settles-unknown-entry',
        detail: 'entry 0 (USD) settles t1, which is no entry of this batch',
      },
    ]);
    const otherSource = leg({ legacy: { kind: 'fee', source: 'bybit-api' } });
    expect(codes(batch({ entries: [trade, otherSource] }))).toEqual(['settles-unknown-entry']);
    const onALeg = leg({ externalId: 't1:fee:fee', settlesExternalId: 't1:fee' });
    expect(codes(batch({ entries: [trade, leg({}), onALeg] }))).toEqual(['settles-unknown-entry']);
  });

  // R57: one input states an event once, so an external id sent for two
  // different rows would keep only the last of them. The problem counts the
  // ids and the entries and names neither.
  test('one external id sent for another asset, holding key or source is refused, and counted', () => {
    const BTC: AssetRef = { identity: { symbol: 'BTC', name: 'Bitcoin' }, typeCode: 'crypto' };
    const shared = (over: Partial<FeedEntry>) => entry({ externalId: 'x1', ...over });
    const otherAsset = shared({ asset: BTC });
    const otherKey = shared({ asset: { ...USD, key: 'pot-b' } });
    const otherSource = shared({ legacy: { kind: 'deposit', source: 'statement-ofx' } });

    for (const second of [otherAsset, otherKey, otherSource]) {
      expect(validateBatch(batch({ entries: [shared({}), second] }), NOW)).toEqual([
        {
          code: 'duplicate-external-id',
          detail:
            '1 external id(s) are each sent for more than one asset or source, by 2 entries in all',
        },
      ]);
    }
    const problems = validateBatch(
      batch({
        entries: [
          shared({}),
          otherAsset,
          otherSource,
          entry({ externalId: 'y1' }),
          entry({ externalId: 'y1', asset: BTC }),
          entry({ externalId: 'z1' }),
        ],
      }),
      NOW
    );
    expect(problems).toEqual([
      {
        code: 'duplicate-external-id',
        detail:
          '2 external id(s) are each sent for more than one asset or source, by 5 entries in all',
      },
    ]);
    expect(problems[0]?.detail).not.toContain('x1');
  });

  // The control: the same event sent twice is a re-send. The write merges it
  // and reports the merge (SC-349), as it always has.
  test('the same entry sent twice is not refused', () => {
    const resent = entry({ externalId: 'x1', amount: '12' });
    expect(validateBatch(batch({ entries: [entry({ externalId: 'x1' }), resent] }), NOW)).toEqual(
      []
    );
  });

  test('it does not modify the batch it reads', () => {
    const b = batch({ entries: [entry({ externalId: '' })] });
    const before = structuredClone(b);
    validateBatch(b, NOW);
    expect(b).toEqual(before);
  });
});
