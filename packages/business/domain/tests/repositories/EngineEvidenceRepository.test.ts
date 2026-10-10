import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray, type SQL, sql } from 'drizzle-orm';
import { PgDialect, parsePgArray } from 'drizzle-orm/pg-core';
import { Container } from 'typedi';
import { priceAt } from '../../src/engine/price-at';
import { LEDGER_KINDS, type PriceReading } from '../../src/engine/types';
import { EngineEvidenceRepository } from '../../src/repositories/EngineEvidenceRepository';
import type { HoldingLabels } from '../../src/services/foundation/legacy-classification';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';
import { liftPriceCheck } from '../../test/helpers/price-check';

const repo = () => Container.get(EngineEvidenceRepository);
const at = (iso: string) => new Date(iso);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const NOTHING = { holdings: 0, observations: 0, entries: 0 };

// The columns the loader reads, pinned: a heavy account's whole history passes
// through them, so a column added here is memory every nightly run pays for.
const HOLDING_COLUMNS = [
  'id',
  'accountId',
  'tokenId',
  'source',
  'externalId',
  'kind',
  'startsAt',
  'balance',
  'lastUpdated',
  'createdAt',
] as const;
const OBSERVATION_COLUMNS = [
  'id',
  'holdingId',
  'balance',
  'observedAt',
  'source',
  'gapReview',
  'role',
  'authority',
  'inputId',
  'cause',
  'supersededAt',
  'createdAt',
] as const;
const DIVIDEND_ROW = '00000000-0000-4000-8000-0000000000d1';

const TRANSACTION_COLUMNS = [
  'id',
  'holdingId',
  'kind',
  'quantity',
  'occurredAt',
  'externalId',
  'source',
  'transferGroupId',
  'swapGroupId',
  'settlesTransactionId',
  'priceNative',
  'priceNativeTokenId',
  'ledgerKind',
  'kindSubtype',
  'groupId',
  'feeOf',
  'inputId',
  'executionPrice',
  'executionPriceTokenId',
  'kindOrigin',
  'decisionId',
  'createdAt',
] as const;
const INPUT_COLUMNS = ['id', 'accountId', 'source'] as const;
const WINDOW_COLUMNS = ['id', 'inputId', 'fromAt', 'toAt'] as const;

function project<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as Pick<T, K>;
}

/** An observation as the loader reads it, `source_metadata` as its three string keys. */
function loaded(
  row: typeof schema.holdingBalanceObservations.$inferSelect,
  metadata: { origin?: string; source?: string; legacyAnchor?: string } = {}
) {
  return {
    ...project(row, OBSERVATION_COLUMNS),
    metadataOrigin: metadata.origin ?? null,
    metadataSource: metadata.source ?? null,
    metadataLegacyAnchor: metadata.legacyAnchor ?? null,
  };
}

async function seedAccount(tx: DatabaseTransaction, userId: string) {
  const institution = await makeInstitution(tx);
  return makeAccount(tx, { userId, institutionId: institution.id });
}

async function seedHolding(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const account = await seedAccount(tx, user.id);
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  return { user, account, token, holding };
}

async function observe(
  tx: DatabaseTransaction,
  holding: { id: string; userId: string },
  observedAt: Date,
  balance: string,
  fields: Partial<typeof schema.holdingBalanceObservations.$inferInsert> = {}
) {
  const [row] = await tx
    .insert(schema.holdingBalanceObservations)
    .values({
      userId: holding.userId,
      holdingId: holding.id,
      balance,
      observedAt,
      source: 'sync-capture',
      ...fields,
    })
    .returning();
  return row!;
}

async function addInput(
  tx: DatabaseTransaction,
  account: { id: string; userId: string },
  source: string
) {
  const [row] = await tx
    .insert(schema.feedInputs)
    .values({ userId: account.userId, accountId: account.id, source })
    .returning();
  return row!;
}

async function addWindow(
  tx: DatabaseTransaction,
  inputId: string,
  fromAt: Date | null,
  toAt: Date
) {
  const [row] = await tx
    .insert(schema.feedInputWindows)
    .values({ inputId, fromAt, toAt, complete: true, fetchedAt: toAt })
    .returning();
  return row!;
}

async function addPrice(
  tx: DatabaseTransaction,
  tokenId: string,
  baseTokenId: string,
  timestamp: Date,
  price: string,
  granularity: string,
  source: string | null = null
) {
  await tx
    .insert(schema.tokenPrices)
    .values({ tokenId, baseTokenId, timestamp, price, granularity, source });
}

function labels(
  holdingId: string,
  fields: Partial<Omit<HoldingLabels, 'holdingId'>>
): HoldingLabels {
  return { holdingId, holding: {}, observations: [], entries: [], ...fields };
}

async function selectRows<T>(tx: DatabaseTransaction, query: SQL): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

/** The SQLSTATE `statement` is refused with, run in a savepoint so the test can go on. */
async function refusedWith(tx: DatabaseTransaction, statement: SQL): Promise<string | undefined> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(statement);
    });
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('findHoldingEvidence', () => {
  test('returns every holding of the user with its rows in time order', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token, holding: first } = await seedHolding(tx);
      const second = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        isHidden: true,
        isActive: false,
      });
      const stranger = await seedHolding(tx);

      const o3 = await observe(tx, first, at('2026-01-03T00:00:00Z'), '30');
      const o1 = await observe(tx, first, at('2026-01-01T00:00:00Z'), '10');
      const tiedA = await observe(tx, first, at('2026-01-02T00:00:00Z'), '20');
      // Another source, since (holding, instant, source) is unique.
      const tiedB = await observe(tx, first, at('2026-01-02T00:00:00Z'), '21', {
        source: 'user-entered',
      });
      const s1 = await observe(tx, second, at('2026-01-05T00:00:00Z'), '5');
      await observe(tx, stranger.holding, at('2026-01-01T00:00:00Z'), '99');
      const t2 = await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: first.id,
        tokenId: token.id,
        occurredAt: at('2026-02-02T00:00:00Z'),
      });
      const t1 = await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: first.id,
        tokenId: token.id,
        occurredAt: at('2026-02-01T00:00:00Z'),
      });

      const evidence = await repo().findHoldingEvidence({ userId: user.id }, tx);

      expect(evidence.map((e) => e.holding.id).toSorted()).toEqual(
        [first.id, second.id].toSorted()
      );
      const ofFirst = evidence.find((e) => e.holding.id === first.id)!;
      const tied = [tiedA, tiedB].toSorted(byId);
      expect(ofFirst.observations.map((o) => o.id)).toEqual([
        o1.id,
        tied[0]!.id,
        tied[1]!.id,
        o3.id,
      ]);
      expect(ofFirst.transactions.map((t) => t.id)).toEqual([t1.id, t2.id]);
      expect(ofFirst.holding).toEqual(project(first, HOLDING_COLUMNS));
      const ofSecond = evidence.find((e) => e.holding.id === second.id)!;
      expect(ofSecond.holding).toEqual(project(second, HOLDING_COLUMNS));
      expect(ofSecond.observations).toEqual([loaded(s1)]);
      expect(ofSecond.transactions).toEqual([]);
    });
  });

  test('reads only the columns classification reads, and source_metadata as its three string keys', async () => {
    await withTestDb(async (tx) => {
      const { user, token, holding } = await seedHolding(tx);
      const created = await observe(tx, holding, at('2026-01-01T00:00:00Z'), '1', {
        sourceMetadata: {
          origin: 'createHoldingWithEvent',
          source: 'blockchain',
          provider: 'etherscan',
        },
      });
      // A key that is not a string reads as absent, as the classifier read it.
      const numeric = await observe(tx, holding, at('2026-01-02T00:00:00Z'), '2', {
        sourceMetadata: { origin: 7, source: true, legacyAnchor: { run: 'apy-payout' } },
      });
      const listed = await observe(tx, holding, at('2026-01-03T00:00:00Z'), '3', {
        sourceMetadata: ['origin'],
      });
      const anchor = await observe(tx, holding, at('2026-01-04T00:00:00Z'), '4', {
        sourceMetadata: { origin: 'updateHoldingBalance', legacyAnchor: 'apy-payout' },
      });
      const entry = await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        tokenId: token.id,
        rawPayload: { body: 'x'.repeat(1000) },
        description: 'coffee',
        counterparty: 'a shop',
        sourceMetadata: {
          income: 'dividend',
          feeOf: DIVIDEND_ROW,
          paidBy: { isin: 'ZZ0000000017' },
        },
      });
      // The same keys, not strings, read as absent.
      const odd = await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        tokenId: token.id,
        occurredAt: at('2026-01-05T00:00:00Z'),
        sourceMetadata: { income: { kind: 'dividend' }, feeOf: 7 },
      });

      const [evidence] = await repo().findHoldingEvidence({ userId: user.id }, tx);

      expect(evidence!.holding).toEqual(project(holding, HOLDING_COLUMNS));
      expect(evidence!.observations).toEqual([
        loaded(created, { origin: 'createHoldingWithEvent', source: 'blockchain' }),
        loaded(numeric),
        loaded(listed),
        loaded(anchor, { origin: 'updateHoldingBalance', legacyAnchor: 'apy-payout' }),
      ]);
      // In `occurred_at` order: `odd` is dated, `entry` is now.
      expect(evidence!.transactions).toEqual([
        { ...project(odd, TRANSACTION_COLUMNS), metadataIncome: null, metadataFeeOf: null },
        {
          ...project(entry, TRANSACTION_COLUMNS),
          metadataIncome: 'dividend',
          metadataFeeOf: DIVIDEND_ROW,
        },
      ]);
    });
  });

  test('a history longer than a page is read whole, in order, across a sub-millisecond boundary', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await seedHolding(tx);
      // 4,999 rows a second apart, then two in one millisecond, 100 µs apart:
      // page one ends on the first of the two. A cursor kept as a JS Date
      // would start page two at the millisecond and read that row again.
      await tx.execute(sql`
        INSERT INTO holding_balance_observations (user_id, holding_id, balance, observed_at, source)
        SELECT ${user.id}, ${holding.id}, g::text,
               timestamptz '2025-01-01' + g * interval '1 second', 'sync-capture'
        FROM generate_series(1, 4999) g`);
      await tx.execute(sql`
        INSERT INTO holding_balance_observations (user_id, holding_id, balance, observed_at, source)
        VALUES (${user.id}, ${holding.id}, '7001', timestamptz '2026-01-01 00:00:00.0001+00', 'sync-capture'),
               (${user.id}, ${holding.id}, '7002', timestamptz '2026-01-01 00:00:00.0002+00', 'sync-capture')`);
      const stored = await selectRows<{ id: string }>(
        tx,
        sql`SELECT id FROM holding_balance_observations WHERE holding_id = ${holding.id}
            ORDER BY observed_at, id`
      );

      const [evidence] = await repo().findHoldingEvidence({ userId: user.id }, tx);

      expect(stored).toHaveLength(5001);
      expect(evidence!.observations.map((o) => o.id)).toEqual(stored.map((r) => r.id));
      expect(evidence!.observations.slice(-2).map((o) => o.balance)).toEqual(['7001', '7002']);
    });
  });

  test('findHoldingIds lists every holding of the user, in the order findHoldingEvidence returns them', async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding: first } = await seedHolding(tx);
      const hidden = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        isHidden: true,
        isActive: false,
      });
      await seedHolding(tx);

      const ids = await repo().findHoldingIds(user.id, tx);

      expect(ids.toSorted()).toEqual([first.id, hidden.id].toSorted());
      const evidence = await repo().findHoldingEvidence({ userId: user.id }, tx);
      expect(ids).toEqual(evidence.map((e) => e.holding.id));
    });
  });

  test('one holding at a time reads exactly what one read per user does', async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding: first } = await seedHolding(tx);
      const sameAccount = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        source: 'blockchain',
      });
      const otherAccount = await seedAccount(tx, user.id);
      const elsewhere = await makeHolding(tx, {
        userId: user.id,
        accountId: otherAccount.id,
        tokenId: (await makeToken(tx)).id,
        source: 'sync_exchange_balances',
      });
      await seedHolding(tx);
      const wallet = await addInput(tx, account, 'etherscan');
      await addWindow(tx, wallet.id, null, at('2026-01-31T00:00:00Z'));
      await addWindow(tx, wallet.id, at('2026-02-01T00:00:00Z'), at('2026-02-28T00:00:00Z'));
      const exchange = await addInput(tx, otherAccount, 'kraken-api');
      await addWindow(tx, exchange.id, null, at('2026-01-31T00:00:00Z'));
      for (const [holding, day] of [
        [first, 1],
        [first, 2],
        [sameAccount, 3],
        [elsewhere, 4],
        [elsewhere, 5],
      ] as const) {
        await observe(tx, holding, at(`2026-01-0${day}T00:00:00Z`), String(day), {
          sourceMetadata: { origin: 'updateHoldingBalanceWithEvent' },
        });
      }
      for (const holding of [first, sameAccount, elsewhere]) {
        await makeHoldingTransaction(tx, {
          userId: user.id,
          holdingId: holding.id,
          tokenId: holding.tokenId,
          source: 'etherscan',
          occurredAt: at('2026-01-10T00:00:00Z'),
        });
      }

      const perUser = await repo().findHoldingEvidence({ userId: user.id }, tx);
      const perHolding = [];
      for (const holdingId of await repo().findHoldingIds(user.id, tx)) {
        perHolding.push(
          ...(await repo().findHoldingEvidence({ userId: user.id, holdingIds: [holdingId] }, tx))
        );
      }

      expect(perUser).toHaveLength(3);
      expect(perUser.map((e) => [e.observations.length, e.transactions.length])).toContainEqual([
        2, 1,
      ]);
      expect(perUser.flatMap((e) => e.windows)).toHaveLength(5);
      expect(perHolding).toEqual(perUser);
    });
  });

  test('holdingIds narrows the scope', async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding: first } = await seedHolding(tx);
      const second = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
      });
      const kept = await observe(tx, second, at('2026-01-01T00:00:00Z'), '1');
      await observe(tx, first, at('2026-01-01T00:00:00Z'), '2');
      const stranger = await seedHolding(tx);

      const narrowed = await repo().findHoldingEvidence(
        { userId: user.id, holdingIds: [second.id, stranger.holding.id] },
        tx
      );
      expect(narrowed.map((e) => [e.holding.id, e.observations.map((o) => o.id)])).toEqual([
        [second.id, [kept.id]],
      ]);
      expect(await repo().findHoldingEvidence({ userId: user.id, holdingIds: [] }, tx)).toEqual([]);
    });
  });

  test("the account's inputs and windows ride along", async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding } = await seedHolding(tx);
      const otherAccount = await seedAccount(tx, user.id);
      const otherHolding = await makeHolding(tx, {
        userId: user.id,
        accountId: otherAccount.id,
        tokenId: (await makeToken(tx)).id,
      });
      const stranger = await seedHolding(tx);

      const wallet = await addInput(tx, account, 'etherscan');
      const statement = await addInput(tx, account, 'statement');
      const exchange = await addInput(tx, otherAccount, 'kraken-api');
      await addInput(tx, stranger.account, 'statement');
      const walletLater = await addWindow(
        tx,
        wallet.id,
        at('2026-02-01T00:00:00Z'),
        at('2026-02-28T00:00:00Z')
      );
      const walletOpen = await addWindow(tx, wallet.id, null, at('2026-01-31T00:00:00Z'));
      const upload = await addWindow(
        tx,
        statement.id,
        at('2026-01-01T00:00:00Z'),
        at('2026-01-31T00:00:00Z')
      );

      const evidence = await repo().findHoldingEvidence({ userId: user.id }, tx);
      const of = (id: string) => evidence.find((e) => e.holding.id === id)!;

      const inputs = (rows: Array<typeof wallet>) => rows.map((r) => project(r, INPUT_COLUMNS));
      const windows = (rows: Array<typeof upload>) => rows.map((r) => project(r, WINDOW_COLUMNS));
      expect(of(holding.id).inputs).toEqual(inputs([wallet, statement]));
      expect(of(holding.id).windows).toEqual(windows([walletOpen, walletLater, upload]));
      expect(of(otherHolding.id).inputs).toEqual(inputs([exchange]));
      expect(of(otherHolding.id).windows).toEqual([]);
    });
  });

  test("holdingIds narrows the inputs and windows to the named holdings' accounts", async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding } = await seedHolding(tx);
      const otherAccount = await seedAccount(tx, user.id);
      await makeHolding(tx, {
        userId: user.id,
        accountId: otherAccount.id,
        tokenId: (await makeToken(tx)).id,
      });
      const wallet = await addInput(tx, account, 'etherscan');
      const walletWindow = await addWindow(tx, wallet.id, null, at('2026-01-31T00:00:00Z'));
      const exchange = await addInput(tx, otherAccount, 'kraken-api');
      await addWindow(tx, exchange.id, null, at('2026-01-31T00:00:00Z'));

      const narrowed = await repo().findHoldingEvidence(
        { userId: user.id, holdingIds: [holding.id] },
        tx
      );

      expect(narrowed.map((e) => [e.holding.id, e.inputs, e.windows])).toEqual([
        [holding.id, [project(wallet, INPUT_COLUMNS)], [project(walletWindow, WINDOW_COLUMNS)]],
      ]);
    });
  });
});

describe('findPriceReadingsAtInstants', () => {
  const ASKED_AT = at('2026-03-10T12:00:00Z');

  /**
   * A pair with a reading of 10 at 08:00 and a row at 11:00, asked at noon:
   * what is loaded of it, and what the engine answers over that.
   */
  async function besideAnOlderReading(
    tx: DatabaseTransaction,
    price: string,
    granularity: string
  ): Promise<{ loaded: string[][]; answer: string | null }> {
    const x = await makeToken(tx);
    const usd = await makeToken(tx);
    await addPrice(tx, x.id, usd.id, at('2026-03-10T08:00:00Z'), '10', 'intraday');
    await addPrice(tx, x.id, usd.id, at('2026-03-10T11:00:00Z'), price, granularity);
    const loaded = await repo().findPriceReadingsAtInstants(
      [{ tokenId: x.id, baseTokenId: usd.id, at: ASKED_AT }],
      tx
    );
    const answer = priceAt(
      { readings: loaded, hubTokenIds: [] },
      { tokenId: x.id, assetClass: 'crypto' },
      usd.id,
      ASKED_AT
    );
    return {
      loaded: loaded.map((r) => [r.price, r.at.toISOString(), r.granularity]),
      answer: answer?.price.toString() ?? null,
    };
  }

  const OLDER = { loaded: [['10', '2026-03-10T08:00:00.000Z', 'intraday']], answer: '10' };

  test('a NaN row at the nearest stamp is not a reading, and the older one answers', async () => {
    await withTestDb(async (tx) => {
      await liftPriceCheck(tx);
      expect(await besideAnOlderReading(tx, 'NaN', 'intraday')).toEqual(OLDER);
      // CONTROL: a reading there is the one loaded, so the older one answers only for want of it.
      expect(await besideAnOlderReading(tx, '11', 'intraday')).toEqual({
        loaded: [['11', '2026-03-10T11:00:00.000Z', 'intraday']],
        answer: '11',
      });
    });
  });

  test('an Infinity row at the nearest stamp is not a reading, and the older one answers', async () => {
    await withTestDb(async (tx) => {
      await liftPriceCheck(tx);
      expect(await besideAnOlderReading(tx, 'Infinity', 'intraday')).toEqual(OLDER);
    });
  });

  test('a row of a granularity the engine does not rank is not a reading, and the older one answers', async () => {
    await withTestDb(async (tx) => {
      expect(await besideAnOlderReading(tx, '11', 'hourly')).toEqual(OLDER);
    });
  });

  test('a padded row at the nearest stamp is not a reading, and the older one answers', async () => {
    await withTestDb(async (tx) => {
      await liftPriceCheck(tx);
      // Postgres reads ' 11' as 11, skipping the space; the engine reads no number in it.
      expect(await besideAnOlderReading(tx, ' 11', 'intraday')).toEqual(OLDER);
    });
  });

  test('a row Postgres cannot read as a number at the nearest stamp is not a reading, and the older one answers', async () => {
    await withTestDb(async (tx) => {
      await liftPriceCheck(tx);
      expect(await besideAnOlderReading(tx, 'abc', 'intraday')).toEqual(OLDER);
    });
  });

  test('a row Postgres cannot read as a number in one pair fails no other pair of the load', async () => {
    await withTestDb(async (tx) => {
      await liftPriceCheck(tx);
      const [x, y, usd] = [await makeToken(tx), await makeToken(tx), await makeToken(tx)];
      await addPrice(tx, x.id, usd.id, at('2026-03-10T08:00:00Z'), '10', 'intraday');
      await addPrice(tx, y.id, usd.id, at('2026-03-10T08:00:00Z'), '7', 'intraday');
      await addPrice(tx, y.id, usd.id, at('2026-03-10T11:00:00Z'), 'abc', 'intraday');

      const loaded = await repo().findPriceReadingsAtInstants(
        [
          { tokenId: x.id, baseTokenId: usd.id, at: ASKED_AT },
          { tokenId: y.id, baseTokenId: usd.id, at: ASKED_AT },
        ],
        tx
      );
      const answer = (tokenId: string) =>
        priceAt(
          { readings: loaded, hubTokenIds: [] },
          { tokenId, assetClass: 'crypto' },
          usd.id,
          ASKED_AT
        )?.price.toString() ?? null;

      expect(loaded.map((r) => r.price).sort()).toEqual(['10', '7']);
      expect(answer(x.id)).toBe('10');
      expect(answer(y.id)).toBe('7');
    });
  });

  test('both rows at the nearest stamp are loaded, so the finer one answers', async () => {
    await withTestDb(async (tx) => {
      const x = await makeToken(tx);
      const usd = await makeToken(tx);
      await addPrice(tx, x.id, usd.id, at('2026-03-10T03:00:00Z'), '9', 'intraday');
      await addPrice(tx, x.id, usd.id, at('2026-03-10T11:00:00Z'), '12', 'daily');
      await addPrice(tx, x.id, usd.id, at('2026-03-10T11:00:00Z'), '11', 'intraday');

      const loaded = await repo().findPriceReadingsAtInstants(
        [{ tokenId: x.id, baseTokenId: usd.id, at: ASKED_AT }],
        tx
      );
      const answer = priceAt(
        { readings: loaded, hubTokenIds: [] },
        { tokenId: x.id, assetClass: 'crypto' },
        usd.id,
        ASKED_AT
      );

      expect(loaded.map((reading) => `${reading.granularity} ${reading.price}`).sort()).toEqual([
        'daily 12',
        'intraday 11',
      ]);
      expect(answer?.price.toString()).toBe('11');
    });
  });

  test('35,000 (pair, instant) asks load in one statement', async () => {
    await withTestDb(async (tx) => {
      const x = await makeToken(tx);
      const usd = await makeToken(tx);
      const closeOf = (day: number) => new Date(Date.UTC(2026, 0, day, 23, 59, 59, 999));
      await addPrice(tx, x.id, usd.id, closeOf(1), '10', 'intraday');
      await addPrice(tx, x.id, usd.id, closeOf(2), '11', 'intraday');
      await addPrice(tx, x.id, usd.id, closeOf(3), '12', 'intraday');
      // A minute apart from the first close: every one a different instant.
      const asks = Array.from({ length: 35_000 }, (_, minute) => ({
        tokenId: x.id,
        baseTokenId: usd.id,
        at: new Date(closeOf(1).getTime() + minute * 60_000),
      }));
      const repeated = [...asks, ...asks.slice(0, 5_000)];

      const execute = spyOn(tx, 'execute');
      let result: PriceReading[];
      let statements: SQL[];
      try {
        result = await repo().findPriceReadingsAtInstants(repeated, tx);
        statements = execute.mock.calls.map(([statement]) => statement as SQL);
      } finally {
        execute.mockRestore();
      }

      expect(statements).toHaveLength(1);
      const { params } = new PgDialect().sqlToQuery(statements[0] as SQL);
      expect(params).toHaveLength(3);
      expect(params.map((param) => parsePgArray(param as string).length)).toEqual([
        35_000, 35_000, 35_000,
      ]);
      expect(result.map((reading) => reading.price).sort()).toEqual(['10', '11', '12']);
    });
  });
});

describe('findQuoteTokenIds', () => {
  test('per token, the bases it has a forward row in at or before `until`', async () => {
    await withTestDb(async (tx) => {
      const [usd, eur, chf] = [await makeToken(tx), await makeToken(tx), await makeToken(tx)];
      const x = await makeToken(tx);
      const reverseOnly = await makeToken(tx);
      const unpriced = await makeToken(tx);
      const until = at('2026-01-10T23:59:59.999Z');
      await addPrice(tx, x.id, usd.id, at('2026-01-03T12:00:00Z'), '10', 'intraday');
      await addPrice(tx, x.id, usd.id, at('2026-01-04T12:00:00Z'), '11', 'intraday');
      await addPrice(tx, x.id, chf.id, until, '9', 'intraday');
      // After `until`: not yet a currency X is quoted in.
      await addPrice(tx, x.id, eur.id, at('2026-01-11T12:00:00Z'), '8', 'intraday');
      // X priced in it is not it priced in X.
      await addPrice(tx, x.id, reverseOnly.id, at('2026-01-03T12:00:00Z'), '2', 'intraday');

      const quotes = await repo().findQuoteTokenIds(
        [x.id, reverseOnly.id, unpriced.id, x.id],
        until,
        tx
      );

      expect([...quotes.keys()]).toEqual([x.id]);
      expect([...(quotes.get(x.id) ?? [])].sort()).toEqual([usd.id, chf.id, reverseOnly.id].sort());
      expect(await repo().findQuoteTokenIds([], until, tx)).toEqual(new Map());
    });
  });
});

describe('findUsersWithHoldings', () => {
  test('lists the users with at least one holding, with their base currency', async () => {
    await withTestDb(async (tx) => {
      const { user } = await seedHolding(tx);
      const usd = await makeToken(tx);
      await tx
        .update(schema.users)
        .set({ baseCurrencyId: usd.id })
        .where(sql`${schema.users.id} = ${user.id}`);
      const idle = await makeUser(tx);

      const users = await repo().findUsersWithHoldings(tx);

      expect(users).toContainEqual({ userId: user.id, baseCurrencyId: usd.id });
      expect(users.map((u) => u.userId)).not.toContain(idle.id);
    });
  });
});

describe('fillMissingLabels', () => {
  test("a label naming another user's rows writes nothing", async () => {
    await withTestDb(async (tx) => {
      const { user } = await seedHolding(tx);
      const stranger = await seedHolding(tx);
      const observation = await observe(tx, stranger.holding, at('2026-01-01T00:00:00Z'), '1');
      const entry = await makeHoldingTransaction(tx, {
        userId: stranger.user.id,
        holdingId: stranger.holding.id,
        tokenId: stranger.token.id,
      });
      const theirs = [
        labels(stranger.holding.id, {
          holding: { kind: 'feed' },
          observations: [{ id: observation.id, role: 'snapshot' }],
          entries: [{ id: entry.id, ledgerKind: 'inflow' }],
        }),
      ];
      const stored = async () =>
        (
          await selectRows<{
            kind: string | null;
            role: string | null;
            ledger_kind: string | null;
          }>(
            tx,
            sql`SELECT
                  (SELECT kind FROM holdings WHERE id = ${stranger.holding.id}) AS kind,
                  (SELECT role FROM holding_balance_observations WHERE id = ${observation.id}) AS role,
                  (SELECT ledger_kind FROM holding_transactions WHERE id = ${entry.id}) AS ledger_kind`
          )
        )[0];

      expect(await repo().fillMissingLabels(user.id, theirs, tx)).toEqual(NOTHING);
      expect(await stored()).toEqual({ kind: null, role: null, ledger_kind: null });
      // CONTROL: the same labels for their owner write all three rows.
      expect(await repo().fillMissingLabels(stranger.user.id, theirs, tx)).toEqual({
        holdings: 1,
        observations: 1,
        entries: 1,
      });
      expect(await stored()).toEqual({ kind: 'feed', role: 'snapshot', ledger_kind: 'inflow' });
    });
  });

  test('updates holdings last, so their row locks are held for the shortest time', async () => {
    await withTestDb(async (tx) => {
      const { user, token, holding } = await seedHolding(tx);
      const observation = await observe(tx, holding, at('2026-01-01T00:00:00Z'), '1');
      const entry = await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        tokenId: token.id,
      });
      const dialect = new PgDialect();
      const execute = tx.execute.bind(tx);
      const updated: string[] = [];
      const spy = spyOn(tx, 'execute').mockImplementation(((query: SQL) => {
        const table = /^\s*UPDATE "(\w+)"/.exec(dialect.sqlToQuery(query).sql)?.[1];
        if (table !== undefined) updated.push(table);
        return execute(query);
      }) as typeof tx.execute);

      let written: Awaited<ReturnType<EngineEvidenceRepository['fillMissingLabels']>>;
      try {
        written = await repo().fillMissingLabels(
          user.id,
          [
            labels(holding.id, {
              holding: { kind: 'feed' },
              observations: [{ id: observation.id, role: 'checkpoint' }],
              entries: [{ id: entry.id, ledgerKind: 'outflow' }],
            }),
          ],
          tx
        );
      } finally {
        spy.mockRestore();
      }

      expect(written).toEqual({ holdings: 1, observations: 1, entries: 1 });
      expect(updated).toEqual(['holding_balance_observations', 'holding_transactions', 'holdings']);
    });
  });

  test('every engine ledger kind is writable and a legacy kind is not', async () => {
    await withTestDb(async (tx) => {
      const { user, token, holding } = await seedHolding(tx);
      const entries = [];
      for (const _ of LEDGER_KINDS) {
        entries.push(
          await makeHoldingTransaction(tx, {
            userId: user.id,
            holdingId: holding.id,
            tokenId: token.id,
          })
        );
      }

      const written = await repo().fillMissingLabels(
        user.id,
        [
          labels(holding.id, {
            entries: entries.map((e, i) => ({ id: e.id, ledgerKind: LEDGER_KINDS[i] })),
          }),
        ],
        tx
      );

      expect(written).toEqual({ holdings: 0, observations: 0, entries: LEDGER_KINDS.length });
      const stored = await selectRows<{ id: string; ledger_kind: string }>(
        tx,
        sql`SELECT id, ledger_kind FROM holding_transactions WHERE holding_id = ${holding.id}`
      );
      expect(stored.map((r) => r.ledger_kind).toSorted()).toEqual([...LEDGER_KINDS].toSorted());
      expect(
        await refusedWith(
          tx,
          sql`UPDATE holding_transactions SET ledger_kind = 'buy' WHERE id = ${entries[0]!.id}`
        )
      ).toBe('23514');
    });
  });

  test('fills NULLs only, and a second call changes nothing', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await seedHolding(tx);
      const blank = await observe(tx, holding, at('2026-01-01T00:00:00Z'), '10');
      const labelled = await observe(tx, holding, at('2026-01-02T00:00:00Z'), '20', {
        role: 'checkpoint',
      });
      const asked = [
        labels(holding.id, {
          observations: [
            { id: blank.id, role: 'verification' },
            { id: labelled.id, role: 'verification' },
          ],
        }),
      ];

      expect(await repo().fillMissingLabels(holding.userId, asked, tx)).toEqual({
        holdings: 0,
        observations: 1,
        entries: 0,
      });
      const roles = await selectRows<{ id: string; role: string }>(
        tx,
        sql`SELECT id, role FROM holding_balance_observations WHERE holding_id = ${holding.id}`
      );
      expect(roles.toSorted(byId)).toEqual(
        [
          { id: blank.id, role: 'verification' },
          { id: labelled.id, role: 'checkpoint' },
        ].toSorted(byId)
      );
      expect(await repo().fillMissingLabels(holding.userId, asked, tx)).toEqual(NOTHING);
    });
  });

  test('fills a holding and an entry column by column', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token, holding: blank } = await seedHolding(tx);
      const kindOnly = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        kind: 'snapshot',
      });
      const complete = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        kind: 'feed',
        startsAt: at('2025-06-01T00:00:00Z'),
      });
      const input = await addInput(tx, account, 'etherscan');
      const entry = (fields: Partial<typeof schema.holdingTransactions.$inferInsert> = {}) =>
        makeHoldingTransaction(tx, {
          userId: user.id,
          holdingId: blank.id,
          tokenId: token.id,
          ...fields,
        });
      const fresh = await entry();
      const kinded = await entry({ ledgerKind: 'outflow' });
      const done = await entry({ ledgerKind: 'fee', inputId: input.id });
      const groupId = randomUUID();
      const feeOf = randomUUID();

      const written = await repo().fillMissingLabels(
        user.id,
        [
          labels(blank.id, {
            holding: { kind: 'feed', startsAt: at('2026-01-01T00:00:00Z') },
            entries: [
              {
                id: fresh.id,
                ledgerKind: 'income',
                kindSubtype: 'interest',
                groupId,
                feeOf,
                inputId: input.id,
                executionPrice: '50000',
                executionPriceTokenId: token.id,
                kindOrigin: 'source',
              },
              { id: kinded.id, ledgerKind: 'inflow', inputId: input.id },
              { id: done.id, ledgerKind: 'inflow', inputId: input.id },
            ],
          }),
          labels(kindOnly.id, { holding: { kind: 'feed', startsAt: at('2026-02-01T00:00:00Z') } }),
          labels(complete.id, {
            holding: { kind: 'snapshot', startsAt: at('2026-03-01T00:00:00Z') },
          }),
        ],
        tx
      );

      expect(written).toEqual({ holdings: 2, observations: 0, entries: 2 });
      const holdings = await tx
        .select({
          id: schema.holdings.id,
          kind: schema.holdings.kind,
          startsAt: schema.holdings.startsAt,
        })
        .from(schema.holdings)
        .where(inArray(schema.holdings.id, [blank.id, kindOnly.id, complete.id]));
      const expected: typeof holdings = [
        { id: blank.id, kind: 'feed', startsAt: at('2026-01-01T00:00:00Z') },
        { id: kindOnly.id, kind: 'snapshot', startsAt: at('2026-02-01T00:00:00Z') },
        { id: complete.id, kind: 'feed', startsAt: at('2025-06-01T00:00:00Z') },
      ];
      expect(holdings.toSorted(byId)).toEqual(expected.toSorted(byId));
      const ledger = await selectRows<{ id: string } & Record<string, string | null>>(
        tx,
        sql`SELECT id, ledger_kind, kind_subtype, group_id, fee_of, input_id, execution_price,
                   execution_price_token_id, kind_origin
            FROM holding_transactions WHERE holding_id = ${blank.id}`
      );
      const none = {
        kind_subtype: null,
        group_id: null,
        fee_of: null,
        execution_price: null,
        execution_price_token_id: null,
        kind_origin: null,
      };
      expect(ledger.toSorted(byId)).toEqual(
        [
          {
            id: fresh.id,
            ledger_kind: 'income',
            kind_subtype: 'interest',
            group_id: groupId,
            fee_of: feeOf,
            input_id: input.id,
            execution_price: '50000',
            execution_price_token_id: token.id,
            kind_origin: 'source',
          },
          { id: kinded.id, ...none, ledger_kind: 'outflow', input_id: input.id },
          { id: done.id, ...none, ledger_kind: 'fee', input_id: input.id },
        ].toSorted(byId)
      );
    });
  });

  test('leaves the observation chain and every column it does not label alone', async () => {
    await withTestDb(async (tx) => {
      const { user, token, holding } = await seedHolding(tx);
      const o1 = await observe(tx, holding, at('2026-01-01T00:00:00Z'), '10');
      const o2 = await observe(tx, holding, at('2026-01-02T00:00:00Z'), '20');
      const e1 = await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        tokenId: token.id,
      });
      const unlabelled = () =>
        Promise.all([
          selectRows(
            tx,
            sql`SELECT to_jsonb(h) - 'kind' - 'starts_at' AS row FROM holdings h WHERE id = ${holding.id}`
          ),
          selectRows(
            tx,
            sql`SELECT to_jsonb(o) - 'role' - 'authority' - 'input_id' - 'cause' AS row
                FROM holding_balance_observations o WHERE holding_id = ${holding.id} ORDER BY id`
          ),
          selectRows(
            tx,
            sql`SELECT to_jsonb(t) - 'ledger_kind' - 'kind_subtype' - 'group_id' - 'fee_of' - 'input_id'
                       - 'execution_price' - 'execution_price_token_id' - 'kind_origin' AS row
                FROM holding_transactions t WHERE holding_id = ${holding.id} ORDER BY id`
          ),
        ]);
      const before = await unlabelled();

      const written = await repo().fillMissingLabels(
        user.id,
        [
          labels(holding.id, {
            holding: { kind: 'snapshot', startsAt: at('2025-12-01T00:00:00Z') },
            observations: [
              { id: o1.id, role: 'snapshot', authority: 'person', cause: 'flow' },
              { id: o2.id, role: 'snapshot', authority: 'person', cause: 'growth' },
            ],
            entries: [{ id: e1.id, ledgerKind: 'outflow', kindOrigin: 'source' }],
          }),
        ],
        tx
      );

      expect(written).toEqual({ holdings: 1, observations: 2, entries: 1 });
      expect(await unlabelled()).toEqual(before);
      const [chain] = await tx
        .select({
          previousObservedAt: schema.holdingBalanceObservations.previousObservedAt,
          previousBalance: schema.holdingBalanceObservations.previousBalance,
        })
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.id, o2.id));
      expect(chain).toEqual({
        previousObservedAt: at('2026-01-01T00:00:00Z'),
        previousBalance: '10',
      });
      const [stored] = await selectRows<{ balance: string }>(
        tx,
        sql`SELECT balance FROM holdings WHERE id = ${holding.id}`
      );
      expect(stored?.balance).toBe(holding.balance);
    });
  });

  test('writes past a batch of 500 rows', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await seedHolding(tx);
      const start = Date.parse('2026-01-01T00:00:00Z');
      const rows = await tx
        .insert(schema.holdingBalanceObservations)
        .values(
          Array.from({ length: 501 }, (_, i) => ({
            userId: holding.userId,
            holdingId: holding.id,
            balance: String(i),
            observedAt: new Date(start + i * 60_000),
            source: 'sync-capture',
          }))
        )
        .returning({ id: schema.holdingBalanceObservations.id });
      const asked = [
        labels(holding.id, { observations: rows.map((r) => ({ id: r.id, role: 'snapshot' })) }),
      ];

      expect(await repo().fillMissingLabels(holding.userId, asked, tx)).toEqual({
        holdings: 0,
        observations: 501,
        entries: 0,
      });
      const [counted] = await selectRows<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM holding_balance_observations WHERE holding_id = ${holding.id} AND role = 'snapshot'`
      );
      expect(counted?.n).toBe(501);
      expect(await repo().fillMissingLabels(holding.userId, asked, tx)).toEqual(NOTHING);
    });
  });
});
