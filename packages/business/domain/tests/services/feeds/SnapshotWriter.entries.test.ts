/**
 * `SnapshotWriter.recordEntries` writes a person's or a system's movements on a
 * snapshot holding (foundation A2): the rows through `bulkUpsert`, labelled and
 * with no input, `starts_at` lowered by D-6, and the cache through
 * `HoldingCacheWriter`, the one A2 writer of `holdings.balance` (D-1). It writes
 * no observation (ruling R11).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { type SnapshotEntry, SnapshotWriter } from '../../../src/services/feeds/SnapshotWriter';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';
import { backendPid, outcomeOf, waitUntilBlocked } from '../../../test/helpers/lock-wait';

const writer = () => Container.get(SnapshotWriter);
const cacheWriter = () => Container.get(HoldingCacheWriter);

const T0 = new Date('2026-07-01T00:00:00Z');
const DAY_MS = 86_400_000;
const daysAfterT0 = (days: number) => new Date(T0.getTime() + days * DAY_MS);
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

async function holdingOf(
  tx: DatabaseTransaction,
  fields: { startsAt?: Date | null; balance?: string } = {}
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
    startsAt: fields.startsAt ?? null,
    lastUpdated: LONG_AGO,
  });
}

function apyEntry(externalId: string, amount: string, occurredAt: Date): SnapshotEntry {
  return {
    externalId,
    amount,
    occurredAt,
    legacy: { kind: 'interest', source: 'apy-payout', sourceMetadata: { configId: 'c-1' } },
  };
}

/** A balance the person typed: the evidence the engine writes the cache from (A5 D-1). */
async function typed(
  tx: DatabaseTransaction,
  holding: { userId: string; id: string },
  amount: string,
  at: Date
) {
  await writer().record(
    {
      userId: holding.userId,
      holdingId: holding.id,
      amount,
      at,
      cause: 'flow',
      legacySource: 'sync-capture',
      legacyMeta: { origin: 'updateHolding' },
    },
    { cache: 'unchanged' },
    tx
  );
}

async function holdingRow(tx: DatabaseTransaction, holdingId: string) {
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
}

describe('SnapshotWriter.recordEntries', () => {
  test('writes the rows labelled, input null, with no observation', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx);
      const entries: SnapshotEntry[] = [
        apyEntry('apy:c-1:2026-07-03', '0.5', daysAfterT0(2)),
        {
          externalId: 'withdraw-1',
          amount: '-2.25',
          occurredAt: daysAfterT0(1),
          legacy: { kind: 'withdraw', source: 'user-entered', sourceMetadata: {} },
        },
      ];

      const outcome = await writer().recordEntries(
        { userId: holding.userId, holdingId: holding.id, entries, cache: null },
        tx
      );

      expect(outcome).toEqual({
        userId: holding.userId,
        touchedHoldingIds: [holding.id],
        createdHoldingIds: [],
        earliestChangedAt: daysAfterT0(1),
        notices: [],
      });
      const t = schema.holdingTransactions;
      const rows = await tx
        .select({
          userId: t.userId,
          tokenId: t.tokenId,
          kind: t.kind,
          quantity: t.quantity,
          occurredAt: t.occurredAt,
          externalId: t.externalId,
          source: t.source,
          sourceMetadata: t.sourceMetadata,
          inputId: t.inputId,
          ledgerKind: t.ledgerKind,
          kindSubtype: t.kindSubtype,
          kindOrigin: t.kindOrigin,
        })
        .from(t)
        .where(eq(t.holdingId, holding.id))
        .orderBy(asc(t.occurredAt));
      const common = { userId: holding.userId, tokenId: holding.tokenId, inputId: null };
      expect(rows).toEqual([
        {
          ...common,
          kind: 'withdraw',
          quantity: '-2.25',
          occurredAt: daysAfterT0(1),
          externalId: 'withdraw-1',
          source: 'user-entered',
          sourceMetadata: {},
          ledgerKind: 'outflow',
          kindSubtype: null,
          kindOrigin: 'person',
        },
        {
          ...common,
          kind: 'interest',
          quantity: '0.5',
          occurredAt: daysAfterT0(2),
          externalId: 'apy:c-1:2026-07-03',
          source: 'apy-payout',
          sourceMetadata: { configId: 'c-1' },
          ledgerKind: 'income',
          kindSubtype: 'apy',
          kindOrigin: 'person',
        },
      ]);
      const observations = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, holding.id));
      expect(observations).toEqual([]);

      // `earliestChangedAt` is the upsert's own: a re-send that changes nothing moved nothing.
      const again = await writer().recordEntries(
        { userId: holding.userId, holdingId: holding.id, entries, cache: null },
        tx
      );
      expect(again.earliestChangedAt).toBeNull();
    });
  });

  test('lowers a non-null starts_at to the earliest entry and leaves a NULL one NULL', async () => {
    await withTestDb(async (tx) => {
      const later = await holdingOf(tx, { startsAt: daysAfterT0(10) });
      const unknown = await holdingOf(tx, { startsAt: null });
      const earlier = await holdingOf(tx, { startsAt: T0 });
      const entries = [
        apyEntry('a', '1', daysAfterT0(5)),
        apyEntry('b', '1', daysAfterT0(3)),
        apyEntry('c', '1', daysAfterT0(7)),
      ];

      for (const holding of [later, unknown, earlier]) {
        await writer().recordEntries(
          { userId: holding.userId, holdingId: holding.id, entries, cache: null },
          tx
        );
      }

      expect((await holdingRow(tx, later.id)).startsAt).toEqual(daysAfterT0(3));
      expect((await holdingRow(tx, unknown.id)).startsAt).toBeNull();
      // Never raised: an earlier start already covers the write.
      expect((await holdingRow(tx, earlier.id)).startsAt).toEqual(T0);
    });
  });

  test('applies the cache write and bumps last_updated, and writes no cache when cache is null', async () => {
    await withTestDb(async (tx) => {
      const cached = await holdingOf(tx, { balance: '100' });
      await typed(tx, cached, '100', T0);
      const untouched = await holdingOf(tx, { balance: '100' });
      const entries = [apyEntry('a', '1.5', daysAfterT0(1))];
      const before = Date.now();

      await writer().recordEntries(
        {
          userId: cached.userId,
          holdingId: cached.id,
          entries,
          cache: { holdingId: cached.id, balance: '101.5' },
        },
        tx
      );
      await writer().recordEntries(
        { userId: untouched.userId, holdingId: untouched.id, entries, cache: null },
        tx
      );

      const after = Date.now();
      const written = await holdingRow(tx, cached.id);
      expect(written.balance).toBe('101.5');
      expect(written.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(written.lastUpdated.getTime()).toBeLessThanOrEqual(after);
      const kept = await holdingRow(tx, untouched.id);
      expect({ balance: kept.balance, lastUpdated: kept.lastUpdated }).toEqual({
        balance: '100',
        lastUpdated: LONG_AGO,
      });
    });
  });

  test('recordEntries refuses a cache write for another holding', async () => {
    await withTestDb(async (tx) => {
      const holding = await holdingOf(tx, { balance: '100' });
      const other = await makeHolding(tx, {
        userId: holding.userId,
        accountId: holding.accountId,
        tokenId: holding.tokenId,
        balance: '7',
        lastUpdated: LONG_AGO,
      });
      const entries = [apyEntry('a', '1', daysAfterT0(1))];

      // A balance on a holding whose ledger did not move is a caller's bug (D-1).
      await expect(
        tx.transaction((savepoint) =>
          writer().recordEntries(
            {
              userId: holding.userId,
              holdingId: holding.id,
              entries,
              cache: { holdingId: other.id, balance: '8' },
            },
            savepoint
          )
        )
      ).rejects.toThrow(other.id);

      expect((await holdingRow(tx, other.id)).balance).toBe('7');
      const rows = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.holdingId, holding.id));
      expect(rows).toEqual([]);
    });
  });

  test("recordEntries refuses another user's holding", async () => {
    await withTestDb(async (tx) => {
      const theirs = await holdingOf(tx);
      const me = await makeUser(tx);
      const entries = [apyEntry('a', '1', daysAfterT0(1))];

      await expect(
        writer().recordEntries({ userId: me.id, holdingId: theirs.id, entries, cache: null }, tx)
      ).rejects.toThrow(theirs.id);

      const rows = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.holdingId, theirs.id));
      expect(rows).toEqual([]);
    });
  });
});

/**
 * The two-connection half: committed fixtures, because a lock is only seen
 * from a second transaction.
 */
describe('SnapshotWriter.recordEntries locks its holding at the level its upsert takes (R81)', () => {
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
   * A writer that names the holding, then writes it, with an APY-shaped
   * `recordEntries` arriving in between. Released once the call waits on the
   * writer, or once it has settled without waiting.
   */
  async function recordEntriesBesideAWriter(entries: readonly SnapshotEntry[]) {
    const holding = await committedSnapshotHolding();
    let inserted!: () => void;
    let proceed!: () => void;
    const rowInserted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const proceeded = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let rowPid: number | undefined;
    let callPid: number | undefined;

    const rowWriter = getDb().transaction(async (tx) => {
      rowPid = await backendPid(tx);
      await makeHoldingTransaction(tx, {
        userId: holding.userId,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '5',
        occurredAt: daysAfterT0(1),
        source: 'user-entered',
      });
      inserted();
      await proceeded;
      await cacheWriter().apply(holding.userId, [{ holdingId: holding.id, balance: '200' }], tx);
    });
    let call: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      await Promise.race([rowInserted, rowWriter]);
      call = getDb().transaction(async (tx) => {
        callPid = await backendPid(tx);
        await writer().recordEntries(
          {
            userId: holding.userId,
            holdingId: holding.id,
            entries,
            cache: { holdingId: holding.id, balance: '101' },
          },
          tx
        );
      });
      blocked = await waitUntilBlocked({ pid: () => callPid, settled: call }, rowPid!);
    } finally {
      proceed();
    }
    const outcomes = await Promise.allSettled([rowWriter, call]);
    return { blocked, outcomes: outcomes.map(outcomeOf) };
  }

  /**
   * FOR UPDATE waits on every uncommitted row naming the holding (KEY SHARE),
   * so taking NO KEY UPDATE first and the upsert's FOR UPDATE after would be
   * an upgrade: the call would hold the row while waiting on the writer, whose
   * balance write then waits on the call.
   */
  test('with entries, it waits out a writer that names the holding and then writes it: both commit (no 40P01)', async () => {
    expect(
      await recordEntriesBesideAWriter([apyEntry('apy:c-1:2026-07-02', '1', daysAfterT0(1))])
    ).toEqual({ blocked: true, outcomes: ['fulfilled', 'fulfilled'] });
  });

  test('with no entries it upserts nothing, so it takes NO KEY UPDATE and does not wait', async () => {
    expect(await recordEntriesBesideAWriter([])).toEqual({
      blocked: false,
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });
});

describe('HoldingCacheWriter.apply', () => {
  test("HoldingCacheWriter refuses another user's holding", async () => {
    await withTestDb(async (tx) => {
      const theirs = await holdingOf(tx, { balance: '100' });
      const me = await makeUser(tx);

      await expect(
        cacheWriter().apply(me.id, [{ holdingId: theirs.id, balance: '5' }], tx)
      ).rejects.toThrow(theirs.id);
      expect((await holdingRow(tx, theirs.id)).balance).toBe('100');

      // The control: the same write as the holding's own user lands.
      await typed(tx, theirs, '5', LONG_AGO);
      await cacheWriter().apply(theirs.userId, [{ holdingId: theirs.id, balance: '5' }], tx);
      expect((await holdingRow(tx, theirs.id)).balance).toBe('5');
    });
  });

  test('last_updated is the instant the caller states, and now when it states none', async () => {
    // D-1: a balance edit stamps last_updated with the edit's own instant, and
    // legacy history walks the ledger back to that column (anchor 2).
    await withTestDb(async (tx) => {
      const stated = await holdingOf(tx, { balance: '100' });
      const unstated = await holdingOf(tx, { balance: '100' });
      await typed(tx, stated, '7', LONG_AGO);
      await typed(tx, unstated, '8', LONG_AGO);
      const editedAt = new Date('2026-03-01T09:30:00.000Z');
      const before = Date.now();

      await cacheWriter().apply(
        stated.userId,
        [{ holdingId: stated.id, balance: '7', lastUpdated: editedAt }],
        tx
      );
      await cacheWriter().apply(unstated.userId, [{ holdingId: unstated.id, balance: '8' }], tx);

      const after = Date.now();
      const statedRow = await holdingRow(tx, stated.id);
      expect({ balance: statedRow.balance, lastUpdated: statedRow.lastUpdated }).toEqual({
        balance: '7',
        lastUpdated: editedAt,
      });
      const unstatedRow = await holdingRow(tx, unstated.id);
      expect(unstatedRow.balance).toBe('8');
      expect(unstatedRow.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(unstatedRow.lastUpdated.getTime()).toBeLessThanOrEqual(after);
    });
  });
});
