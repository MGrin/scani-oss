/**
 * `SnapshotWriter.record` writes a person's value on a holding (foundation A2):
 * one observation, its role by Rule P (a snapshot until the holding's feed has
 * produced evidence, a verification from then on), authority `person`, no
 * input, with the cause; `starts_at` lowered by D-6; and the cache, when asked, through
 * `HoldingCacheWriter` (D-1). `HoldingResolver.createSnapshotHolding` is the one
 * holding INSERT on a person path: an empty cache and no observation (D-4).
 *
 * The same-instant rule is A1 carry-forward 2. Before it, a plain value that
 * superseded a same-instant correction stayed plain, so the engine dropped the
 * window the correction had taken over and read the instants before it as
 * preceding every value.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { balanceAt } from '../../../src/engine/balance-at';
import type { HoldingEvidence, SnapshotCause } from '../../../src/engine/types';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { HoldingResolver } from '../../../src/services/feeds/HoldingResolver';
import { type SnapshotValue, SnapshotWriter } from '../../../src/services/feeds/SnapshotWriter';
import { classifyHoldingEvidence } from '../../../src/services/foundation/legacy-classification';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';
import { expectPersonRolesAsClassified } from '../../../test/helpers/labels-settled';
import { backendPid, waitUntilBlocked } from '../../../test/helpers/lock-wait';
import { derived } from '../../engine/fixtures';

const writer = () => Container.get(SnapshotWriter);
const resolver = () => Container.get(HoldingResolver);

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const T0 = new Date('2026-07-01T00:00:00Z');
const DAY_MS = 86_400_000;
const daysAfterT0 = (days: number) => new Date(T0.getTime() + days * DAY_MS);

async function holdingOf(
  tx: DatabaseTransaction,
  fields: { kind: 'snapshot' | 'feed' | null; startsAt?: Date | null; balance?: string }
) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const token = await makeToken(tx);
  return makeHolding(tx, {
    userId,
    accountId: account.id,
    tokenId: token.id,
    balance: fields.balance ?? '100',
    kind: fields.kind,
    startsAt: fields.startsAt === undefined ? LONG_AGO : fields.startsAt,
    lastUpdated: LONG_AGO,
  });
}

function valueOn(
  holding: { id: string; userId: string },
  amount: string,
  at: Date,
  fields: Partial<SnapshotValue> = {}
): SnapshotValue {
  return {
    userId: holding.userId,
    holdingId: holding.id,
    amount,
    at,
    cause: 'flow',
    legacySource: 'sync-capture',
    legacyMeta: { origin: 'updateHolding' },
    ...fields,
  };
}

const observationsOf = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(
      asc(schema.holdingBalanceObservations.observedAt),
      asc(schema.holdingBalanceObservations.source)
    );

/** The person values' labels: a checkpoint seeded as the feed's evidence is left out. */
const labelsOf = async (tx: DatabaseTransaction, holdingId: string) =>
  (await observationsOf(tx, holdingId))
    .filter((r) => r.authority === 'person')
    .map((r) => ({
      balance: r.balance,
      role: r.role,
      cause: r.cause,
      superseded: r.supersededAt !== null,
    }));

/**
 * A live person snapshot on a holding that is not a snapshot one now: typed
 * before a feed began, or labelled by the backfill. Its source differs from
 * `valueOn`'s, so a value at the same instant is a second row and not a
 * collision.
 */
async function seedPersonSnapshot(
  tx: DatabaseTransaction,
  holding: { id: string; userId: string },
  balance: string,
  observedAt: Date,
  cause: SnapshotCause
) {
  await tx.insert(schema.holdingBalanceObservations).values({
    userId: holding.userId,
    holdingId: holding.id,
    balance,
    observedAt,
    source: 'user-entered',
    role: 'snapshot',
    authority: 'person',
    cause,
  });
}

async function holdingRow(tx: DatabaseTransaction, holdingId: string) {
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
}

async function engineEvidence(
  tx: DatabaseTransaction,
  holding: { id: string; userId: string }
): Promise<HoldingEvidence> {
  const [raw] = await Container.get(EngineEvidenceRepository).findHoldingEvidence(
    { userId: holding.userId, holdingIds: [holding.id] },
    tx
  );
  if (!raw) throw new Error(`no evidence for holding ${holding.id}`);
  return classifyHoldingEvidence(raw).evidence;
}

describe('SnapshotWriter.record', () => {
  test('on a snapshot holding it writes role snapshot, authority person, input null, with the cause', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot', startsAt: daysAfterT0(5) });
      const answeredAt = daysAfterT0(3);

      const outcome = await writer().record(
        valueOn(holding, '120.5', daysAfterT0(2), {
          cause: 'growth',
          legacyMeta: { origin: 'updateHolding' },
          attestation: { answer: 'growth', at: answeredAt },
        }),
        { cache: 'unchanged' },
        tx
      );

      expect(outcome).toEqual({
        userId: holding.userId,
        touchedHoldingIds: [holding.id],
        createdHoldingIds: [],
        earliestChangedAt: daysAfterT0(2),
        notices: [],
      });
      const rows = await observationsOf(tx, holding.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: holding.userId,
        balance: '120.5',
        observedAt: daysAfterT0(2),
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
        role: 'snapshot',
        authority: 'person',
        inputId: null,
        cause: 'growth',
        supersededAt: null,
        gapReview: 'growth',
        gapReviewSource: 'user',
        gapReviewedAt: answeredAt,
      });
      const after = await holdingRow(tx, holding.id);
      // D-6: the value is earlier than the holding's start, so it moves the start back.
      expect(after.startsAt).toEqual(daysAfterT0(2));
      // `unchanged` leaves the cache alone.
      expect({ balance: after.balance, lastUpdated: after.lastUpdated }).toEqual({
        balance: '100',
        lastUpdated: LONG_AGO,
      });
    });
  });

  test("on a feed holding whose feed has begun it writes a verification, and the cache keeps the feed's figure (A5 D-20)", async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'feed', balance: '100' });
      await makeCheckpoint(tx, { userId: holding.userId, holdingId: holding.id, observedAt: T0 });
      const before = Date.now();

      await writer().record(
        valueOn(holding, '175', daysAfterT0(1), { cause: null }),
        {
          cache: 'set',
        },
        tx
      );

      const after = Date.now();
      const rows = (await observationsOf(tx, holding.id)).filter((r) => r.authority === 'person');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        balance: '175',
        role: 'verification',
        authority: 'person',
        inputId: null,
        cause: null,
        supersededAt: null,
      });
      // A verification never anchors, so today's figure is still the feed's
      // checkpoint; the app says so on save (A5 D-20).
      const written = await holdingRow(tx, holding.id);
      expect(written.balance).toBe('100');
      expect(written.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(written.lastUpdated.getTime()).toBeLessThanOrEqual(after);
    });
  });

  test('on a NULL-kind holding it persists no role', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: null, startsAt: null });

      await writer().record(valueOn(holding, '90', daysAfterT0(1)), { cache: 'unchanged' }, tx);

      const rows = await observationsOf(tx, holding.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        role: null,
        authority: 'person',
        inputId: null,
        cause: 'flow',
      });
      // A NULL start stays NULL for the backfill (D-6).
      expect((await holdingRow(tx, holding.id)).startsAt).toBeNull();
    });
  });

  // Rule P (D7, R85): a feed that has produced no evidence has not begun, so a
  // value typed on it is a snapshot, and replaces as one.
  test('on a feed holding whose feed has not begun it writes a snapshot, and a correction replaces the snapshot before it (R85)', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'feed' });

      await writer().record(valueOn(holding, '110', daysAfterT0(1)), { cache: 'unchanged' }, tx);
      await writer().record(
        valueOn(holding, '105', daysAfterT0(2), { cause: 'correction' }),
        { cache: 'unchanged' },
        tx
      );

      expect(await labelsOf(tx, holding.id)).toEqual([
        { balance: '110', role: 'snapshot', cause: 'flow', superseded: true },
        { balance: '105', role: 'snapshot', cause: 'correction', superseded: false },
      ]);
      await expectPersonRolesAsClassified(holding.userId, tx);
    });
  });

  test('a value is a verification from the feed’s first evidence on, a checkpoint or a feed-sourced entry, and a snapshot before it (R85)', async () => {
    await withTestDb(async (tx) => {
      const byCheckpoint = await holdingOf(tx, { kind: 'feed' });
      await makeCheckpoint(tx, {
        userId: byCheckpoint.userId,
        holdingId: byCheckpoint.id,
        observedAt: daysAfterT0(5),
      });
      const byEntry = await holdingOf(tx, { kind: 'feed' });
      await makeHoldingTransaction(tx, {
        userId: byEntry.userId,
        holdingId: byEntry.id,
        kind: 'deposit',
        quantity: '10',
        occurredAt: daysAfterT0(5),
        source: 'etherscan',
      });

      for (const holding of [byCheckpoint, byEntry]) {
        for (const [amount, day] of [
          ['90', 3],
          ['100', 5],
          ['110', 7],
        ] as const) {
          await writer().record(
            valueOn(holding, amount, daysAfterT0(day)),
            { cache: 'unchanged' },
            tx
          );
        }
        expect((await labelsOf(tx, holding.id)).map((l) => [l.balance, l.role])).toEqual([
          ['90', 'snapshot'],
          ['100', 'verification'],
          ['110', 'verification'],
        ]);
        await expectPersonRolesAsClassified(holding.userId, tx);
      }
    });
  });

  // The invariant on its own: whatever the kind and wherever the feed's first
  // evidence falls, the label written is the one O2's classifier derives (R85).
  // The kind Rule P reads is the classifier's too: a row still stored as a
  // snapshot holding that a feed-sourced entry has made a feed one (K3) reads
  // as a feed, as it does in the engine.
  test('the role written is the one the backfill derives for the row, on a snapshot holding, on a feed one either side of its first evidence, and on a snapshot row the classifier reads as a feed', async () => {
    await withTestDb(async (tx) => {
      const snapshot = await holdingOf(tx, { kind: 'snapshot' });
      const silentFeed = await holdingOf(tx, { kind: 'feed' });
      const begunFeed = await holdingOf(tx, { kind: 'feed' });
      await makeCheckpoint(tx, {
        userId: begunFeed.userId,
        holdingId: begunFeed.id,
        observedAt: daysAfterT0(2),
      });
      const fedSnapshot = await holdingOf(tx, { kind: 'snapshot' });
      await makeHoldingTransaction(tx, {
        userId: fedSnapshot.userId,
        holdingId: fedSnapshot.id,
        kind: 'deposit',
        quantity: '10',
        occurredAt: daysAfterT0(2),
        source: 'etherscan',
      });

      for (const holding of [snapshot, silentFeed, begunFeed, fedSnapshot]) {
        for (const day of [1, 3]) {
          await writer().record(
            valueOn(holding, '100', daysAfterT0(day)),
            { cache: 'unchanged' },
            tx
          );
        }
        await expectPersonRolesAsClassified(holding.userId, tx);
      }
    });
  });

  test('a value at the instant of a live correction supersedes it and becomes a correction', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot' });
      const [t0, between, entryAt, t1] = [
        daysAfterT0(0),
        daysAfterT0(1),
        daysAfterT0(2),
        daysAfterT0(3),
      ];
      await makeHoldingTransaction(tx, {
        userId: holding.userId,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '5',
        occurredAt: entryAt,
        source: 'user-entered',
      });

      // P, then C correcting it, then V at C's own instant. C and V carry
      // different sources: the dedup key is (holding, instant, source).
      await writer().record(valueOn(holding, '100', t0), { cache: 'unchanged' }, tx);
      await writer().record(
        valueOn(holding, '150', t1, { cause: 'correction', legacySource: 'manual-correction' }),
        { cache: 'unchanged' },
        tx
      );
      const outcome = await writer().record(
        valueOn(holding, '160', t1, { cause: 'flow' }),
        {
          cache: 'unchanged',
        },
        tx
      );

      expect(outcome.earliestChangedAt).toEqual(t1);
      const rows = await observationsOf(tx, holding.id);
      expect(
        rows.map((r) => ({
          balance: r.balance,
          cause: r.cause,
          superseded: r.supersededAt !== null,
        }))
      ).toEqual([
        { balance: '100', cause: 'flow', superseded: true },
        { balance: '150', cause: 'correction', superseded: true },
        { balance: '160', cause: 'correction', superseded: false },
      ]);

      const evidence = await engineEvidence(tx, holding);
      const atT1 = derived(balanceAt(evidence, t1));
      expect(atT1.balance.toFixed()).toBe('160');
      expect(atT1.method).toBe('forward');
      const walked = derived(balanceAt(evidence, between));
      expect(walked.balance.toFixed()).toBe('155');
      expect(walked.method).toBe('walk-back');
      expect(walked.anchorAt).toEqual(t1);

      // The control: V left plain is what happened before this rule. The
      // window C took over from P is gone, and the engine reads `between` as
      // an instant before every value.
      const plain = {
        ...evidence,
        observations: evidence.observations.map((o) =>
          o.amount === '160' ? { ...o, cause: 'flow' as const } : o
        ),
      };
      const fellBack = derived(balanceAt(plain, between));
      expect(fellBack.balance.toFixed()).toBe('160');
      expect(fellBack.method).toBe('first-snapshot');
    });
  });

  test('a correction supersedes the previous live snapshot', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot' });
      await writer().record(valueOn(holding, '100', daysAfterT0(0)), { cache: 'unchanged' }, tx);
      await writer().record(valueOn(holding, '110', daysAfterT0(1)), { cache: 'unchanged' }, tx);

      const outcome = await writer().record(
        valueOn(holding, '130', daysAfterT0(2), { cause: 'correction' }),
        { cache: 'unchanged' },
        tx
      );

      // The evidence that changed reaches back to the value it corrected.
      expect(outcome.earliestChangedAt).toEqual(daysAfterT0(1));
      const rows = await observationsOf(tx, holding.id);
      expect(
        rows.map((r) => ({
          balance: r.balance,
          cause: r.cause,
          superseded: r.supersededAt !== null,
        }))
      ).toEqual([
        // Only the latest: a correction replaces one value, not the history before it.
        { balance: '100', cause: 'flow', superseded: false },
        { balance: '110', cause: 'flow', superseded: true },
        { balance: '130', cause: 'correction', superseded: false },
      ]);
    });
  });

  test('a correction at the instant of a live value supersedes that value, not the one before it', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot' });
      await writer().record(valueOn(holding, '100', daysAfterT0(0)), { cache: 'unchanged' }, tx);
      await writer().record(valueOn(holding, '110', daysAfterT0(1)), { cache: 'unchanged' }, tx);

      await writer().record(
        valueOn(holding, '115', daysAfterT0(1), {
          cause: 'correction',
          legacySource: 'manual-correction',
        }),
        { cache: 'unchanged' },
        tx
      );

      const rows = await observationsOf(tx, holding.id);
      expect(
        rows.map((r) => ({
          balance: r.balance,
          cause: r.cause,
          superseded: r.supersededAt !== null,
        }))
      ).toEqual([
        { balance: '100', cause: 'flow', superseded: false },
        { balance: '115', cause: 'correction', superseded: false },
        { balance: '110', cause: 'flow', superseded: true },
      ]);
    });
  });

  // Ruling R7: only a snapshot-role value replaces another. A verification
  // never anchors, so superseding a snapshot with one would remove an anchor
  // and put nothing in its place.
  test('a verification at the instant of a live person snapshot leaves that snapshot live', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'feed' });
      await makeCheckpoint(tx, {
        userId: holding.userId,
        holdingId: holding.id,
        observedAt: LONG_AGO,
      });
      await seedPersonSnapshot(tx, holding, '100', daysAfterT0(1), 'correction');

      const outcome = await writer().record(
        valueOn(holding, '120', daysAfterT0(1), { cause: 'flow' }),
        { cache: 'unchanged' },
        tx
      );

      expect(outcome.earliestChangedAt).toEqual(daysAfterT0(1));
      expect(await labelsOf(tx, holding.id)).toEqual([
        // The new row keeps the cause it was given: nothing was replaced, so
        // there is no correction to carry.
        { balance: '120', role: 'verification', cause: 'flow', superseded: false },
        { balance: '100', role: 'snapshot', cause: 'correction', superseded: false },
      ]);
    });
  });

  test('a correction on a feed holding whose feed has begun supersedes nothing', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'feed' });
      await makeCheckpoint(tx, {
        userId: holding.userId,
        holdingId: holding.id,
        observedAt: LONG_AGO,
      });
      await seedPersonSnapshot(tx, holding, '100', daysAfterT0(0), 'flow');

      const outcome = await writer().record(
        valueOn(holding, '130', daysAfterT0(1), { cause: 'correction' }),
        { cache: 'unchanged' },
        tx
      );

      // The value's own instant, not the earlier snapshot's: that row did not change.
      expect(outcome.earliestChangedAt).toEqual(daysAfterT0(1));
      expect(await labelsOf(tx, holding.id)).toEqual([
        { balance: '100', role: 'snapshot', cause: 'flow', superseded: false },
        { balance: '130', role: 'verification', cause: 'correction', superseded: false },
      ]);
    });
  });

  test('a value with no role supersedes nothing', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: null });
      await seedPersonSnapshot(tx, holding, '100', daysAfterT0(0), 'flow');
      await seedPersonSnapshot(tx, holding, '110', daysAfterT0(1), 'flow');

      await writer().record(
        valueOn(holding, '130', daysAfterT0(1), { cause: 'correction' }),
        { cache: 'unchanged' },
        tx
      );

      expect(await labelsOf(tx, holding.id)).toEqual([
        { balance: '100', role: 'snapshot', cause: 'flow', superseded: false },
        { balance: '130', role: null, cause: 'correction', superseded: false },
        { balance: '110', role: 'snapshot', cause: 'flow', superseded: false },
      ]);
    });
  });

  test('a value that collides with an observation at its instant and source is not recorded, supersedes nothing, and says so', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot', balance: '100' });
      await writer().record(valueOn(holding, '100', daysAfterT0(1)), { cache: 'unchanged' }, tx);

      const outcome = await writer().record(
        valueOn(holding, '140', daysAfterT0(1)),
        {
          cache: 'set',
        },
        tx
      );

      expect(outcome.earliestChangedAt).toBeNull();
      expect(outcome.notices).toEqual([
        `holding ${holding.id} already has a sync-capture observation at ${daysAfterT0(1).toISOString()}; the value 140 was not recorded`,
      ]);
      const rows = await observationsOf(tx, holding.id);
      expect(
        rows.map((r) => ({ balance: r.balance, superseded: r.supersededAt !== null }))
      ).toEqual([{ balance: '100', superseded: false }]);
      // A value that was not recorded is not evidence, so the figure stays the
      // recorded one (A5 D-1).
      expect((await holdingRow(tx, holding.id)).balance).toBe('100');
    });
  });

  test('a future instant is recorded at now', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot' });
      const before = Date.now();

      await writer().record(
        valueOn(holding, '100', new Date(before + DAY_MS)),
        { cache: 'unchanged' },
        tx
      );

      const after = Date.now();
      const [row] = await observationsOf(tx, holding.id);
      expect(row?.observedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row?.observedAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  test('an append failure throws rather than being swallowed', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot' });
      // A cause the column's CHECK refuses, so the INSERT itself fails.
      const refused = 'unexplained' as unknown as SnapshotCause;

      const thrown = await tx
        .transaction((savepoint) =>
          writer().record(
            valueOn(holding, '100', daysAfterT0(1), { cause: refused }),
            { cache: 'set' },
            savepoint
          )
        )
        .then(
          () => null,
          (error: unknown) => error
        );

      // The INSERT's own refusal, by SQLSTATE and constraint. Were it swallowed,
      // the next statement in the savepoint would fail too, but as 25P02
      // (transaction aborted), and a bare `rejects.toThrow()` would pass on that.
      const refusal = thrown as {
        code?: string;
        constraint_name?: string;
        cause?: { code?: string; constraint_name?: string };
      } | null;
      expect({
        code: refusal?.cause?.code ?? refusal?.code,
        constraint: refusal?.cause?.constraint_name ?? refusal?.constraint_name,
      }).toEqual({ code: '23514', constraint: 'holding_obs_cause_chk' });

      expect(await observationsOf(tx, holding.id)).toEqual([]);
      expect((await holdingRow(tx, holding.id)).balance).toBe('100');
    });
  });

  /**
   * R74. A value with no cause is still a snapshot, and the backfill would give
   * it the cause Rule C derives, so it is filled at write instead: on the
   * holding's first snapshot that is money in, and on a later one with nothing
   * to pair it with there is none to give.
   */
  test('a value with no cause takes the cause A1 derives: flow as the first snapshot, none after it (R74)', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { kind: 'snapshot' });

      for (const [amount, day] of [
        ['100', 1],
        ['110', 2],
      ] as const) {
        await writer().record(
          valueOn(holding, amount, daysAfterT0(day), { cause: null }),
          { cache: 'unchanged' },
          tx
        );
      }

      expect(await labelsOf(tx, holding.id)).toEqual([
        { balance: '100', role: 'snapshot', cause: 'flow', superseded: false },
        { balance: '110', role: 'snapshot', cause: null, superseded: false },
      ]);
      const [raw] = await Container.get(EngineEvidenceRepository).findHoldingEvidence(
        { userId: holding.userId, holdingIds: [holding.id] },
        tx
      );
      expect(classifyHoldingEvidence(raw!).unlabelled.observations).toBe(0);
    });
  });

  test("record refuses another user's holding", async () => {
    await withTestDb(async (tx) => {
      const theirs = await holdingOf(tx, { kind: 'snapshot' });
      const me = await makeUser(tx);

      await expect(
        writer().record(
          { ...valueOn(theirs, '1', daysAfterT0(1)), userId: me.id },
          { cache: 'set' },
          tx
        )
      ).rejects.toThrow(theirs.id);

      expect(await observationsOf(tx, theirs.id)).toEqual([]);
    });
  });
});

/**
 * R75. `record` locks the holding row before it reads anything, so the order
 * R72 gives an edit holds for every caller. Committed, on two connections,
 * because the race is between two transactions.
 */
describe('SnapshotWriter.record holds the holding while it reads (R75)', () => {
  const created = { users: [] as string[], tokens: [] as string[], institutions: [] as string[] };

  afterEach(async () => {
    const db = getDb();
    const users = created.users.splice(0);
    const tokens = created.tokens.splice(0);
    const institutions = created.institutions.splice(0);
    // Users first: their holdings are what keep the tokens restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  async function committedSnapshotHolding() {
    return await getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      const bank = await makeInstitutionType(tx, { code: 'bank' });
      const institution = await makeInstitution(tx, { typeId: bank.id });
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '100',
        kind: 'snapshot',
        startsAt: LONG_AGO,
        lastUpdated: LONG_AGO,
      });
      created.users.push(user.id);
      created.tokens.push(token.id);
      created.institutions.push(institution.id);
      return holding;
    });
  }

  /**
   * The first value leaves the cache alone, so the only row lock it holds on
   * the holding is the one `record` takes. The second sets the cache, as
   * `CreateHoldingsWithDependenciesUseCase` does. Without the lock the second
   * read past the uncommitted first value before it waited at all, then waited
   * at its own observation insert behind the per-holding lock the relink
   * trigger takes (SC-1319), and both stayed live. So the wait alone proves
   * nothing here; the supersession does.
   */
  test('a second value waits for the first, then supersedes the one it committed', async () => {
    const holding = await committedSnapshotHolding();
    let wrote!: () => void;
    let release!: () => void;
    const firstWrote = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstPid: number | undefined;
    let secondPid: number | undefined;

    const first = getDb().transaction(async (tx) => {
      firstPid = await backendPid(tx);
      await writer().record(valueOn(holding, '120', daysAfterT0(1)), { cache: 'unchanged' }, tx);
      wrote();
      await released;
    });
    let second: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      await Promise.race([firstWrote, first]);
      second = getDb().transaction(async (tx) => {
        secondPid = await backendPid(tx);
        await writer().record(
          valueOn(holding, '130', daysAfterT0(2), { cause: 'correction' }),
          { cache: 'set' },
          tx
        );
      });
      blocked = await waitUntilBlocked({ pid: () => secondPid, settled: second }, firstPid!);
    } finally {
      release();
    }
    await Promise.all([first, second]);

    expect(blocked).toBe(true);
    const rows = await getDb()
      .select()
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, holding.id))
      .orderBy(asc(schema.holdingBalanceObservations.observedAt));
    expect(rows.map((r) => ({ balance: r.balance, live: r.supersededAt === null }))).toEqual([
      { balance: '120', live: false },
      { balance: '130', live: true },
    ]);
  });
});

describe('HoldingResolver.createSnapshotHolding', () => {
  test('createSnapshotHolding inserts kind snapshot, starts_at = at, balance 0, and no observation', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const before = Date.now();

      const created = await resolver().createSnapshotHolding(
        {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          label: 'Savings',
          source: 'manual',
          arrival: 'user_confirmed',
          at: T0,
        },
        tx
      );
      const unattributed = await resolver().createSnapshotHolding(
        {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          label: null,
          source: 'manual',
          arrival: null,
          at: T0,
        },
        tx
      );

      const after = Date.now();
      const row = await holdingRow(tx, created.id);
      expect(row).toEqual(created);
      expect(row).toMatchObject({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '0',
        kind: 'snapshot',
        startsAt: T0,
        source: 'manual',
        arrival: 'user_confirmed',
        label: 'Savings',
        externalId: null,
      });
      expect(row.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.lastUpdated.getTime()).toBeLessThanOrEqual(after);
      expect((await holdingRow(tx, unattributed.id)).arrival).toBe('unattributed');
      expect(await observationsOf(tx, created.id)).toEqual([]);
    });
  });
});
