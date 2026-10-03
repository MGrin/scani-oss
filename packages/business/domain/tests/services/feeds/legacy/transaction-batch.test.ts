/**
 * `legacyTransactionBatch`, the transaction import's adapter (foundation A2
 * Task 11), and what ingest writes from it. The router's materialisation tests
 * moved here with the materialisation: the settlement and own-fee fixtures
 * (SC-1453, SC-1486), the review-gated wallet (SC-343), swap groups (SC-332)
 * and conversions (SC-1452), each now read off the ledger ingest wrote.
 *
 * The database tests run inside a rolled-back transaction, so ingest resolves
 * inside it and one transaction's `now()` stamps every holding it creates.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { TransactionEvent } from '@scani/providers/core/types';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../../src/repositories/HoldingRepository';
import { declareWindow } from '../../../../src/services/feeds/blocks/window-declarer';
import { deterministicUuid } from '../../../../src/services/feeds/deterministic-id';
import { FeedIngestService } from '../../../../src/services/feeds/FeedIngestService';
import type { AssetRef, FeedBatch } from '../../../../src/services/feeds/feed-batch';
import { legacyTransactionBatch } from '../../../../src/services/feeds/legacy/transaction-batch';
import { TokenIdentityService } from '../../../../src/services/tokens/TokenIdentityService';
import { withTestDb } from '../../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../../test/helpers/factories-extra';

const AT = new Date('2026-07-14T14:30:00Z');
const FETCHED = new Date('2026-07-20T00:00:00Z');
const DAY_MS = 86_400_000;

/** A symbol no other test and no seed holds. */
const freshSymbol = () => `T${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

const coin = (symbol: string) => ({ symbol, name: symbol });

const batchOf = (
  events: TransactionEvent[],
  source = 'ibkr-api',
  context: Partial<Parameters<typeof legacyTransactionBatch>[0]['context']> = {}
): FeedBatch =>
  legacyTransactionBatch({
    userId: 'user-1',
    accountId: 'account-1',
    source,
    events,
    context: { fetchedAt: FETCHED, retracted: false, ...context },
  });

describe('legacyTransactionBatch — the batch', () => {
  test("one entry per event, in order, carrying today's row columns and its other tokens", () => {
    const event: TransactionEvent = {
      externalId: 'buy-1',
      occurredAt: AT,
      kind: 'buy',
      primary: { tokenIdentity: coin('VOO'), quantity: '2', tokenType: 'stock' },
      counter: { tokenIdentity: coin('USD'), quantity: '-1000', tokenType: 'fiat' },
      fee: { tokenIdentity: coin('USD'), quantity: '-1', tokenType: 'fiat' },
      priceNative: { value: '500', quoteIdentity: coin('USD'), tokenType: 'fiat' },
      swapGroupKey: 'g-1',
      counterparty: 'a broker',
      description: 'bought two',
      rawPayload: { id: 7 },
    };
    const plain: TransactionEvent = {
      externalId: 'dep-1',
      occurredAt: AT,
      kind: 'deposit',
      primary: { tokenIdentity: coin('USD'), quantity: '10', tokenType: 'fiat' },
    };
    const usd: AssetRef = { identity: coin('USD'), typeCode: 'fiat', lookup: 'identity' };

    expect(batchOf([event, plain]).entries).toEqual([
      {
        externalId: 'buy-1',
        asset: { identity: coin('VOO'), typeCode: 'stock', lookup: 'identity' },
        amount: '2',
        occurredAt: AT,
        groupKey: 'g-1',
        counterparty: 'a broker',
        description: 'bought two',
        legacyAssets: { counter: usd, fee: usd, priceQuote: usd },
        legacy: {
          kind: 'buy',
          source: 'ibkr-api',
          sourceMetadata: {},
          rawPayload: { id: 7 },
          priceNative: '500',
          counterQuantity: '-1000',
          feeQuantity: '-1',
        },
      },
      {
        externalId: 'dep-1',
        asset: usd,
        amount: '10',
        occurredAt: AT,
        legacyAssets: {},
        legacy: {
          kind: 'deposit',
          source: 'ibkr-api',
          sourceMetadata: {},
          rawPayload: null,
          priceNative: null,
          counterQuantity: null,
          feeQuantity: null,
        },
      },
    ]);
  });

  test('a type hint names one of the five seeded types, and anything else is crypto', () => {
    const typed = (tokenType: string | undefined, i: number): TransactionEvent => ({
      externalId: `e-${i}`,
      occurredAt: AT,
      kind: 'deposit',
      primary: { tokenIdentity: coin(`X${i}`), quantity: '1', tokenType },
    });
    const hints = ['crypto', 'fiat', 'stock', 'private-company', 'other', 'nft', undefined];
    expect(batchOf(hints.map(typed)).entries.map((e) => e.asset.typeCode)).toEqual([
      'crypto',
      'fiat',
      'stock',
      'private-company',
      'other',
      'crypto',
      'crypto',
    ]);
  });

  // The router resolved an identity once per run, keyed without its type, so
  // the first mention's hint decided the token every later mention reused.
  test('an identity takes the type its first mention hinted, as the router resolved it once per run', () => {
    const batch = batchOf([
      {
        externalId: 'buy-1',
        occurredAt: AT,
        kind: 'buy',
        primary: { tokenIdentity: coin('ABC'), quantity: '1' },
        counter: { tokenIdentity: coin('QQQ'), quantity: '-5', tokenType: 'fiat' },
      },
      {
        externalId: 'dep-1',
        occurredAt: AT,
        kind: 'deposit',
        primary: { tokenIdentity: coin('qqq'), quantity: '5' },
        fee: { tokenIdentity: coin('ABC'), quantity: '-1', tokenType: 'stock' },
      },
    ]);
    const [buy, deposit] = batch.entries;
    expect([
      buy?.asset.typeCode,
      buy?.legacyAssets?.counter?.typeCode,
      deposit?.asset.typeCode,
      deposit?.legacyAssets?.fee?.typeCode,
    ]).toEqual(['crypto', 'fiat', 'fiat', 'crypto']);
  });

  test('a review-gated wallet finds only and an exchange creates; the rest are the router options', () => {
    expect(batchOf([], 'etherscan').legacy.holdingPolicy).toBe('find-only');
    expect(batchOf([], 'solana').legacy.holdingPolicy).toBe('find-only');
    expect(batchOf([], 'kraken-api').legacy).toEqual({
      holdingMatch: 'ingest-order',
      holdingPolicy: 'create',
      holdingSource: 'ingest-backfill',
      arrival: null,
      writesCache: false,
      createdWithoutCheckpoint: 'zero',
      cacheObservation: null,
      derivesTradeLegs: true,
      holdingFailure: 'skip-entry',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unhideOnNonZero: false,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    });
  });

  test('it states no leg and no balance: ingest derives the legs once tokens are known', () => {
    const batch = batchOf([
      {
        externalId: 'buy-1',
        occurredAt: AT,
        kind: 'buy',
        primary: { tokenIdentity: coin('VOO'), quantity: '2' },
        counter: { tokenIdentity: coin('USD'), quantity: '-1000' },
      },
    ]);
    expect(batch.entries.map((e) => e.settlesExternalId)).toEqual([undefined]);
    expect(batch.checkpoints).toEqual([]);
    expect(batch.absences).toEqual([]);
    expect(batch.input).toEqual({
      accountId: 'account-1',
      source: 'ibkr-api',
      credentialId: null,
      walletId: null,
    });
  });

  test('the window follows declareWindow for a warm since-run, a cold full run, a retracted run and a horizon provider', () => {
    const early = new Date('2026-03-02T00:00:00Z');
    const events: TransactionEvent[] = [
      {
        externalId: 'a',
        occurredAt: AT,
        kind: 'deposit',
        primary: { tokenIdentity: coin('X'), quantity: '1' },
      },
      {
        externalId: 'b',
        occurredAt: early,
        kind: 'deposit',
        primary: { tokenIdentity: coin('X'), quantity: '1' },
      },
    ];
    const since = new Date('2026-07-01T00:00:00Z');
    const bound = new Date('2026-01-01T00:00:00Z');
    const runs = {
      warm: { since, retracted: false },
      cold: { retracted: false },
      retracted: { retracted: true },
      retractedWithBound: { retracted: true, historyStartsAt: bound },
      horizon: { retracted: false, horizonMs: 30 * DAY_MS },
    };
    const windows = Object.fromEntries(
      Object.entries(runs).map(([name, context]) => [
        name,
        batchOf(events, 'ibkr-api', context).window,
      ])
    );
    for (const [name, context] of Object.entries(runs)) {
      expect(windows[name]).toEqual(
        declareWindow({
          shape: 'transaction-run',
          fetchedAt: FETCHED,
          firstEventAt: early,
          ...context,
        })
      );
    }
    expect(windows).toEqual({
      warm: { from: since, to: FETCHED, complete: true },
      cold: { from: null, to: FETCHED, complete: true },
      retracted: { from: early, to: FETCHED, complete: false },
      retractedWithBound: { from: bound, to: FETCHED, complete: false },
      horizon: { from: new Date(FETCHED.getTime() - 30 * DAY_MS), to: FETCHED, complete: false },
    });
  });

  test('a run that read nothing, or only future-dated events, still bounds its window', () => {
    const later = new Date(FETCHED.getTime() + DAY_MS);
    const future: TransactionEvent = {
      externalId: 'f',
      occurredAt: later,
      kind: 'deposit',
      primary: { tokenIdentity: coin('X'), quantity: '1' },
    };
    expect(batchOf([], 'ibkr-api', { retracted: true }).window).toEqual({
      from: FETCHED,
      to: FETCHED,
      complete: false,
    });
    expect(batchOf([future], 'ibkr-api', { retracted: true }).window).toEqual({
      from: FETCHED,
      to: FETCHED,
      complete: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Through ingest, against the database.
// ---------------------------------------------------------------------------

const ingest = (batch: FeedBatch, tx: DatabaseTransaction) =>
  Container.get(FeedIngestService).ingest(batch, tx);

async function owner(tx: DatabaseTransaction) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  return { userId, accountId: account.id };
}

type Owner = Awaited<ReturnType<typeof owner>>;

const importInto = (
  tx: DatabaseTransaction,
  who: Owner,
  source: string,
  events: TransactionEvent[]
) =>
  ingest(
    legacyTransactionBatch({
      ...who,
      source,
      events,
      context: { fetchedAt: FETCHED, retracted: false },
    }),
    tx
  );

/** Token symbols, so a row reads as the router's tests read it. */
async function symbolsOf(tx: DatabaseTransaction, tokenIds: readonly (string | null)[]) {
  const ids = [...new Set(tokenIds.filter((id): id is string => id !== null))];
  const tokens = ids.length
    ? await tx.select().from(schema.tokens).where(inArray(schema.tokens.id, ids))
    : [];
  const symbolOf = new Map(tokens.map((t) => [t.id, t.symbol]));
  return (id: string | null) => (id === null ? null : (symbolOf.get(id) ?? id));
}

/** The user's ledger in written order, and each row's holding by its token. */
async function ledger(tx: DatabaseTransaction, userId: string) {
  const rows = await tx
    .select({ row: schema.holdingTransactions, holdingTokenId: schema.holdings.tokenId })
    .from(schema.holdingTransactions)
    .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
    .where(eq(schema.holdingTransactions.userId, userId))
    .orderBy(
      asc(schema.holdingTransactions.occurredAt),
      asc(schema.holdingTransactions.externalId)
    );
  const symbol = await symbolsOf(
    tx,
    rows.flatMap(({ row, holdingTokenId }) => [
      holdingTokenId,
      row.tokenId,
      row.counterTokenId,
      row.feeTokenId,
      row.priceNativeTokenId,
    ])
  );
  const externalIdOf = new Map(rows.map(({ row }) => [row.id, row.externalId]));
  return rows.map(({ row, holdingTokenId }) => ({
    ...row,
    holding: symbol(holdingTokenId),
    token: symbol(row.tokenId),
    counter: symbol(row.counterTokenId),
    fee: symbol(row.feeTokenId),
    quote: symbol(row.priceNativeTokenId),
    settlesExternalId: row.settlesTransactionId
      ? (externalIdOf.get(row.settlesTransactionId) ?? null)
      : null,
  }));
}

const holdingsOf = (tx: DatabaseTransaction, accountId: string) =>
  tx.select().from(schema.holdings).where(eq(schema.holdings.accountId, accountId));

/** The router's `stockTrade`, in symbols the test owns. */
function trade(
  symbols: { stock: string; cash: string },
  over: Partial<TransactionEvent> = {}
): TransactionEvent {
  return {
    externalId: 'trade-1',
    occurredAt: AT,
    kind: 'buy',
    primary: { tokenIdentity: coin(symbols.stock), quantity: '2', tokenType: 'stock' },
    counter: { tokenIdentity: coin(symbols.cash), quantity: '-1000', tokenType: 'fiat' },
    fee: { tokenIdentity: coin(symbols.cash), quantity: '-1', tokenType: 'fiat' },
    priceNative: { value: '500', quoteIdentity: coin(symbols.cash), tokenType: 'fiat' },
    ...over,
  };
}

const symbolsFor = () => ({ stock: freshSymbol(), cash: freshSymbol(), other: freshSymbol() });

const tokenIdOf = async (tx: DatabaseTransaction, symbol: string) =>
  (await tx.select().from(schema.tokens).where(eq(schema.tokens.symbol, symbol)))[0]?.id;

const FAILING_STATEMENT = sql`select 1 / 0`;

/** What Postgres says to the statement a failing holding insert runs. */
const databaseErrorMessage = (tx: DatabaseTransaction) =>
  tx
    .transaction((inner) => inner.execute(FAILING_STATEMENT))
    .then(
      () => 'no error',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );

/**
 * Makes inserting a holding of `symbol` raise a real database error inside
 * the caller's transaction, as a violated constraint would: without a
 * savepoint the transaction is aborted and every later statement fails 25P02.
 */
function failHoldingInsertsOf(symbol: string) {
  const repository = Container.get(HoldingRepository);
  const create = repository.create.bind(repository);
  return spyOn(repository, 'create').mockImplementation(async (values, transaction) => {
    if (!transaction) throw new Error('a holding insert outside a transaction');
    const [token] = await transaction
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, values.tokenId));
    if (token?.symbol === symbol) await transaction.execute(FAILING_STATEMENT);
    return await create(values, transaction);
  });
}

describe('legacyTransactionBatch through ingest — settlements (SC-1453)', () => {
  test('an IBKR buy writes the trade, its settlement and its commission, linked and labelled with the input', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      const result = await importInto(tx, who, 'ibkr-api', [trade(s)]);

      const rows = await ledger(tx, who.userId);
      expect(result.notices).toEqual([]);
      expect(result.rowsSent).toBe(3);
      expect(result.entryOutcomes).toEqual(['landed']);
      expect(rows.map((r) => [r.holding, r.kind, r.quantity, r.externalId])).toEqual([
        [s.stock, 'buy', '2', 'trade-1'],
        [s.cash, 'fee', '-1', 'trade-1:fee'],
        [s.cash, 'settle_out', '-1000', 'trade-1:settle'],
      ]);
      for (const leg of rows.filter((r) => r.kind !== 'buy')) {
        expect({
          token: leg.token,
          occurredAt: leg.occurredAt,
          source: leg.source,
          sourceMetadata: leg.sourceMetadata,
          settles: leg.settlesExternalId,
          inputId: leg.inputId,
          counter: leg.counter,
          counterQuantity: leg.counterQuantity,
          priceNative: leg.priceNative,
          feeQuantity: leg.feeQuantity,
          swapGroupId: leg.swapGroupId,
        }).toEqual({
          token: s.cash,
          occurredAt: AT,
          source: 'ibkr-api',
          sourceMetadata: { settles: 'trade-1' },
          settles: 'trade-1',
          inputId: result.inputId,
          counter: null,
          counterQuantity: null,
          priceNative: null,
          feeQuantity: null,
          swapGroupId: null,
        });
      }
      expect(rows.map((r) => r.inputId)).toEqual([result.inputId, result.inputId, result.inputId]);
    });
  });

  test('an IBKR sell settles into the cash holding', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'ibkr-api', [
        trade(s, {
          kind: 'sell',
          primary: { tokenIdentity: coin(s.stock), quantity: '-2', tokenType: 'stock' },
          counter: { tokenIdentity: coin(s.cash), quantity: '1000', tokenType: 'fiat' },
          fee: undefined,
        }),
      ]);
      expect((await ledger(tx, who.userId)).map((r) => [r.kind, r.quantity])).toEqual([
        ['sell', '-2'],
        ['settle_in', '1000'],
      ]);
    });
  });

  test('a trade in a currency the account holds no row of creates a feed holding for it', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      const result = await importInto(tx, who, 'ibkr-api', [trade(s, { fee: undefined })]);
      const symbol = await symbolsOf(
        tx,
        (await holdingsOf(tx, who.accountId)).map((h) => h.tokenId)
      );
      expect(
        (await holdingsOf(tx, who.accountId))
          .map((h) => ({
            token: symbol(h.tokenId),
            balance: h.balance,
            source: h.source,
            externalId: h.externalId,
            kind: h.kind,
            startsAt: h.startsAt,
          }))
          .sort((a, b) => String(a.token).localeCompare(String(b.token)))
      ).toEqual(
        [s.cash, s.stock].sort().map((token) => ({
          token,
          balance: '0',
          source: 'ingest-backfill',
          externalId: null,
          kind: 'feed',
          startsAt: AT,
        }))
      );
      expect(result.createdHoldingIds).toHaveLength(2);
    });
  });

  test('an IBKR currency conversion is already both sides, so only its commission is added', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'ibkr-api', [
        trade(s, {
          externalId: 'fx-1',
          primary: { tokenIdentity: coin(s.other), quantity: '500', tokenType: 'fiat' },
          counter: { tokenIdentity: coin(s.cash), quantity: '-545.25', tokenType: 'fiat' },
          fee: { tokenIdentity: coin(s.cash), quantity: '-2', tokenType: 'fiat' },
          priceNative: undefined,
        }),
        trade(s, {
          externalId: 'fx-1:quote',
          kind: 'sell',
          primary: { tokenIdentity: coin(s.cash), quantity: '-545.25', tokenType: 'fiat' },
          counter: { tokenIdentity: coin(s.other), quantity: '500', tokenType: 'fiat' },
          fee: undefined,
          priceNative: undefined,
        }),
      ]);
      expect(
        (await ledger(tx, who.userId)).map((r) => [r.holding, r.kind, r.quantity, r.externalId])
      ).toEqual([
        [s.other, 'buy', '500', 'fx-1'],
        [s.cash, 'fee', '-2', 'fx-1:fee'],
        [s.cash, 'sell', '-545.25', 'fx-1:quote'],
      ]);
    });
  });

  test('a Kraken trade writes only the trade, because Kraken reports the cash row itself', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'kraken-api', [trade(s, { externalId: 'kraken-1' })]);
      expect((await ledger(tx, who.userId)).map((r) => r.kind)).toEqual(['buy']);
    });
  });

  // R37: the router caught a holding that could not be resolved, warned, and
  // dropped the leg; the trade still landed without its cash side.
  test('a leg whose holding cannot be created is skipped with the router notices, and its trade lands', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      const message = await databaseErrorMessage(tx);
      const spy = failHoldingInsertsOf(s.cash);
      let result: Awaited<ReturnType<typeof importInto>>;
      try {
        result = await importInto(tx, who, 'ibkr-api', [trade(s, { fee: undefined })]);
      } finally {
        spy.mockRestore();
      }
      const cashId = await tokenIdOf(tx, s.cash);
      expect(result.notices).toEqual([
        `Failed to resolve holding for token ${cashId}: ${message}`,
        'Skipped 1 settlement leg(s): the holding for their currency could not be resolved, so those trades are recorded without their cash side and that cash balance will not reconcile.',
      ]);
      expect(result.noticeDetails.map((d) => d.key)).toEqual([null, null]);
      expect(result.entryOutcomes).toEqual(['landed']);
      expect(result.rowsSent).toBe(1);
      // The transaction is still usable: the failed insert was inside a savepoint.
      expect((await ledger(tx, who.userId)).map((r) => [r.holding, r.kind])).toEqual([
        [s.stock, 'buy'],
      ]);
      const symbol = await symbolsOf(
        tx,
        (await holdingsOf(tx, who.accountId)).map((h) => h.tokenId)
      );
      expect((await holdingsOf(tx, who.accountId)).map((h) => symbol(h.tokenId))).toEqual([
        s.stock,
      ]);
    });
  });

  test('an entry whose holding cannot be created is skipped with the router notice, once per entry, and the rest lands', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const [bad, good] = [freshSymbol(), freshSymbol()];
      const message = await databaseErrorMessage(tx);
      const deposit = (externalId: string, symbol: string): TransactionEvent => ({
        externalId,
        occurredAt: AT,
        kind: 'deposit',
        primary: { tokenIdentity: coin(symbol), quantity: '1' },
      });
      const spy = failHoldingInsertsOf(bad);
      let result: Awaited<ReturnType<typeof importInto>>;
      try {
        result = await importInto(tx, who, 'kraken-api', [
          deposit('dep-1', bad),
          deposit('dep-2', good),
          deposit('dep-3', bad),
        ]);
      } finally {
        spy.mockRestore();
      }
      const line = `Failed to resolve holding for token ${await tokenIdOf(tx, bad)}: ${message}`;
      expect(result.notices).toEqual([line, line]);
      expect(result.entryOutcomes).toEqual(['skipped', 'landed', 'skipped']);
      expect(result.rowsSent).toBe(1);
      expect((await ledger(tx, who.userId)).map((r) => [r.externalId, r.holding])).toEqual([
        ['dep-2', good],
      ]);
    });
  });

  // The file import never caught a holding it could not create, so its upload
  // failed whole; that path keeps `holdingFailure: 'fail-batch'`.
  test('control: under fail-batch the same database error fails the batch and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      const message = await databaseErrorMessage(tx);
      const batch = legacyTransactionBatch({
        ...who,
        source: 'ibkr-api',
        events: [trade(s, { fee: undefined })],
        context: { fetchedAt: FETCHED, retracted: false },
      });
      const spy = failHoldingInsertsOf(s.cash);
      try {
        await expect(
          tx.transaction((inner) =>
            ingest({ ...batch, legacy: { ...batch.legacy, holdingFailure: 'fail-batch' } }, inner)
          )
        ).rejects.toThrow(message);
      } finally {
        spy.mockRestore();
      }
      expect(await ledger(tx, who.userId)).toEqual([]);
      expect(await holdingsOf(tx, who.accountId)).toEqual([]);
    });
  });

  // The router also counted such a leg in the wallet-review skip notice; ingest
  // does not. Inert: no wallet source derives legs (Task 11 review M9).
  test('under find-only a leg with no holding is skipped and counted in the settlement-leg notice only', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      const stock = await makeToken(tx, { symbol: s.stock });
      await makeHolding(tx, { ...who, tokenId: stock.id, externalId: `${s.stock}-wallet` });
      const batch = legacyTransactionBatch({
        ...who,
        source: 'ibkr-api',
        events: [
          trade(s, { fee: undefined, primary: { tokenIdentity: coin(s.stock), quantity: '2' } }),
        ],
        context: { fetchedAt: FETCHED, retracted: false },
      });
      const result = await ingest(
        { ...batch, legacy: { ...batch.legacy, holdingPolicy: 'find-only' } },
        tx
      );
      expect((await ledger(tx, who.userId)).map((r) => r.kind)).toEqual(['buy']);
      expect(result.notices).toEqual([
        'Skipped 1 settlement leg(s): the holding for their currency could not be resolved, so those trades are recorded without their cash side and that cash balance will not reconcile.',
      ]);
    });
  });
});

// SC-1486: Kraken and Bybit report a fee charged in the row's own token only
// on the row's fee field, with the quantity gross of it.
describe("legacyTransactionBatch through ingest — a fee in the row's own token is its own row (SC-1486)", () => {
  test('a Kraken cash sale with a fee in that cash writes the fee row, linked to its sale', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'kraken-api', [
        trade(s, {
          externalId: 'kraken-usd-1',
          kind: 'sell',
          primary: { tokenIdentity: coin(s.cash), quantity: '-514.29', tokenType: 'fiat' },
          counter: undefined,
          fee: { tokenIdentity: coin(s.cash), quantity: '-7.71', tokenType: 'fiat' },
          priceNative: undefined,
        }),
      ]);
      expect(
        (await ledger(tx, who.userId)).map((r) => [
          r.holding,
          r.kind,
          r.quantity,
          r.externalId,
          r.settlesExternalId,
        ])
      ).toEqual([
        [s.cash, 'sell', '-514.29', 'kraken-usd-1', null],
        [s.cash, 'fee', '-7.71', 'kraken-usd-1:fee', 'kraken-usd-1'],
      ]);
    });
  });

  test('a Kraken staking reward net of its fee writes the fee row', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'kraken-api', [
        trade(s, {
          externalId: 'kraken-reward-1',
          kind: 'reward',
          primary: { tokenIdentity: coin(s.other), quantity: '0.0002345678', tokenType: 'crypto' },
          counter: undefined,
          fee: { tokenIdentity: coin(s.other), quantity: '-0.0000123456', tokenType: 'crypto' },
          priceNative: undefined,
        }),
      ]);
      expect((await ledger(tx, who.userId)).map((r) => [r.kind, r.quantity, r.externalId])).toEqual(
        [
          ['reward', '0.0002345678', 'kraken-reward-1'],
          ['fee', '-0.0000123456', 'kraken-reward-1:fee'],
        ]
      );
    });
  });

  test('a Bybit buy with its fee in the coin bought writes the settlement and the fee row', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'bybit-api', [
        trade(s, {
          externalId: 'bybit-1',
          primary: { tokenIdentity: coin(s.other), quantity: '0.00034567', tokenType: 'crypto' },
          counter: { tokenIdentity: coin(s.cash), quantity: '-20', tokenType: 'crypto' },
          fee: { tokenIdentity: coin(s.other), quantity: '-0.000000345', tokenType: 'crypto' },
          priceNative: undefined,
        }),
      ]);
      expect(
        (await ledger(tx, who.userId)).map((r) => [r.holding, r.kind, r.quantity, r.externalId])
      ).toEqual([
        [s.other, 'buy', '0.00034567', 'bybit-1'],
        [s.other, 'fee', '-0.000000345', 'bybit-1:fee'],
        [s.cash, 'settle_out', '-20', 'bybit-1:settle'],
      ]);
    });
  });

  test('control: IBKR, which reports net quantities, gets no own-token fee row', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const s = symbolsFor();
      await importInto(tx, who, 'ibkr-api', [
        trade(s, {
          externalId: 'fx-2',
          kind: 'sell',
          primary: { tokenIdentity: coin(s.cash), quantity: '-100', tokenType: 'fiat' },
          counter: { tokenIdentity: coin(s.other), quantity: '137', tokenType: 'fiat' },
          fee: { tokenIdentity: coin(s.cash), quantity: '-2', tokenType: 'fiat' },
          priceNative: undefined,
        }),
      ]);
      expect((await ledger(tx, who.userId)).filter((r) => r.kind === 'fee')).toEqual([]);
    });
  });
});

describe('legacyTransactionBatch through ingest — the rows the router built', () => {
  test('a single deposit becomes one row with every column the router wrote', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const btc = freshSymbol();
      const result = await importInto(tx, who, 'kraken-api', [
        {
          externalId: 'deposit-1',
          occurredAt: AT,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: btc, name: 'Bitcoin' }, quantity: '0.5' },
          counterparty: 'an exchange',
          description: 'a deposit',
          rawPayload: { refid: 'r-1' },
        },
      ]);
      const [row] = await ledger(tx, who.userId);
      expect({
        holding: row?.holding,
        token: row?.token,
        kind: row?.kind,
        quantity: row?.quantity,
        source: row?.source,
        externalId: row?.externalId,
        occurredAt: row?.occurredAt,
        sourceMetadata: row?.sourceMetadata,
        rawPayload: row?.rawPayload,
        counterparty: row?.counterparty,
        description: row?.description,
        inputId: row?.inputId,
      }).toEqual({
        holding: btc,
        token: btc,
        kind: 'deposit',
        quantity: '0.5',
        source: 'kraken-api',
        externalId: 'deposit-1',
        occurredAt: AT,
        sourceMetadata: {},
        rawPayload: { refid: 'r-1' },
        counterparty: 'an exchange',
        description: 'a deposit',
        inputId: result.inputId,
      });
    });
  });

  // SC-343. Under find-only a token the database does not already hold can
  // never yield a holding, so creating it would only leave a row behind.
  test('a wallet mints no token it cannot use, says so, and still lands what the user kept', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const kept = await makeToken(tx, { symbol: freshSymbol() });
      await makeHolding(tx, { ...who, tokenId: kept.id, externalId: `${kept.symbol}-wallet` });
      const spam = freshSymbol();
      const counter = freshSymbol();
      const identities = Container.get(TokenIdentityService);
      const lookups = spyOn(identities, 'findByIdentity');
      try {
        const result = await importInto(tx, who, 'etherscan', [
          ...[1, 2, 3].map((n) => ({
            externalId: `spam-${n}`,
            occurredAt: AT,
            kind: 'transfer_in' as const,
            primary: { tokenIdentity: coin(spam), quantity: '1000' },
          })),
          {
            externalId: 'kept-1',
            occurredAt: AT,
            kind: 'swap_out',
            primary: { tokenIdentity: coin(kept.symbol), quantity: '-1' },
            counter: { tokenIdentity: coin(counter), quantity: '20' },
          },
        ]);
        expect((await ledger(tx, who.userId)).map((r) => [r.externalId, r.counter])).toEqual([
          ['kept-1', counter],
        ]);
        expect(result.notices).toEqual([
          "Skipped 3 tx event(s) referencing 1 token(s) the user didn't keep during wallet review.",
        ]);
        expect(result.entryOutcomes).toEqual(['skipped', 'skipped', 'skipped', 'landed']);
        // Looked up once and missed once; the kept token once.
        expect(lookups).toHaveBeenCalledTimes(2);
        const minted = await tx
          .select({ symbol: schema.tokens.symbol })
          .from(schema.tokens)
          .where(inArray(schema.tokens.symbol, [spam, counter]));
        // The counter of a surviving swap leg is still created (SC-332).
        expect(minted.map((t) => t.symbol)).toEqual([counter]);
      } finally {
        lookups.mockRestore();
      }
    });
  });

  test('an exchange creates the token, because a deposit needs no review', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const xrp = freshSymbol();
      await importInto(tx, who, 'kraken-api', [
        {
          externalId: 'dep-1',
          occurredAt: AT,
          kind: 'deposit',
          primary: { tokenIdentity: coin(xrp), quantity: '10' },
        },
      ]);
      expect((await ledger(tx, who.userId)).map((r) => r.token)).toEqual([xrp]);
    });
  });

  test('a lookup that throws is one keyed line per asset, with the upstream message as a param', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const bad = freshSymbol();
      const identities = Container.get(TokenIdentityService);
      const spy = spyOn(identities, 'findOrCreateByIdentity').mockImplementation(async () => {
        throw new Error('CoinGecko rejected request: 429 Too Many Requests');
      });
      try {
        const result = await importInto(
          tx,
          who,
          'binance-api',
          [1, 2].map((n) => ({
            externalId: `e-${n}`,
            occurredAt: AT,
            kind: 'deposit' as const,
            primary: { tokenIdentity: coin(bad), quantity: '1' },
          }))
        );
        const text = `Failed to resolve token identity ${bad}: CoinGecko rejected request: 429 Too Many Requests`;
        expect(result.noticeDetails).toEqual([
          {
            key: 'v3.jobs.notices.tokenIdentityFailed',
            params: { identity: bad, error: 'CoinGecko rejected request: 429 Too Many Requests' },
            text,
          },
        ]);
        expect(result.notices).toEqual([text]);
        expect(result.entryOutcomes).toEqual(['skipped', 'skipped']);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('legacyTransactionBatch through ingest — swap groups (SC-332)', () => {
  const swapLegs = (
    eth: string,
    usdc: string,
    key = '1:0xswap',
    suffix = ''
  ): TransactionEvent[] => [
    {
      externalId: `0xswap${suffix}`,
      occurredAt: AT,
      kind: 'swap_out',
      primary: { tokenIdentity: coin(eth), quantity: '-1' },
      counter: { tokenIdentity: coin(usdc), quantity: '2000' },
      priceNative: { value: '2000', quoteIdentity: coin(usdc) },
      swapGroupKey: key,
    },
    {
      externalId: `0xswap-0xusdc${suffix}`,
      occurredAt: AT,
      kind: 'swap_in',
      primary: { tokenIdentity: coin(usdc), quantity: '2000' },
      counter: { tokenIdentity: coin(eth), quantity: '-1' },
      priceNative: { value: '0.0005', quoteIdentity: coin(eth) },
      swapGroupKey: key,
    },
  ];

  /** A wallet holding the given tokens, as review left it. */
  async function wallet(tx: DatabaseTransaction, kept: readonly string[]) {
    const who = await owner(tx);
    for (const symbol of kept) {
      const token = await makeToken(tx, { symbol });
      await makeHolding(tx, { ...who, tokenId: token.id, externalId: `${symbol}-wallet` });
    }
    return who;
  }

  test('both legs of a swap share one id, derived from the input and the key, and keep it on re-import', async () => {
    await withTestDb(async (tx) => {
      const [eth, usdc] = [freshSymbol(), freshSymbol()];
      const who = await wallet(tx, [eth, usdc]);
      const events = [...swapLegs(eth, usdc), ...swapLegs(eth, usdc, '1:0xother', '-b')];

      const first = await importInto(tx, who, 'etherscan', events);
      const before = await ledger(tx, who.userId);
      const again = await importInto(tx, who, 'etherscan', events);
      const after = await ledger(tx, who.userId);

      expect(before.map((r) => [r.externalId, r.kind, r.swapGroupId])).toEqual([
        ['0xswap', 'swap_out', deterministicUuid(first.inputId, '1:0xswap')],
        ['0xswap-0xusdc', 'swap_in', deterministicUuid(first.inputId, '1:0xswap')],
        ['0xswap-0xusdc-b', 'swap_in', deterministicUuid(first.inputId, '1:0xother')],
        ['0xswap-b', 'swap_out', deterministicUuid(first.inputId, '1:0xother')],
      ]);
      expect(again.inputId).toBe(first.inputId);
      expect(after.map((r) => [r.id, r.swapGroupId, r.quantity])).toEqual(
        before.map((r) => [r.id, r.swapGroupId, r.quantity])
      );
    });
  });

  test('a leg whose partner was dropped reverts to a plain transfer, by its own sign, and says so', async () => {
    await withTestDb(async (tx) => {
      const [eth, usdc] = [freshSymbol(), freshSymbol()];
      const outOnly = await wallet(tx, [eth]);
      const inOnly = await wallet(tx, [usdc]);

      const out = await importInto(tx, outOnly, 'etherscan', swapLegs(eth, usdc));
      const inn = await importInto(tx, inOnly, 'etherscan', swapLegs(eth, usdc));

      const [orphan] = await ledger(tx, outOnly.userId);
      expect({
        kind: orphan?.kind,
        swapGroupId: orphan?.swapGroupId,
        counterTokenId: orphan?.counterTokenId,
        priceNative: orphan?.priceNative,
      }).toEqual({
        kind: 'transfer_out',
        swapGroupId: null,
        counterTokenId: null,
        priceNative: null,
      });
      expect((await ledger(tx, inOnly.userId)).map((r) => r.kind)).toEqual(['transfer_in']);
      for (const result of [out, inn]) {
        expect(result.notices[0]).toMatch(/swap leg\(s\) as plain transfers/);
      }
    });
  });

  test('an event with no swap key is untouched', async () => {
    await withTestDb(async (tx) => {
      const eth = freshSymbol();
      const who = await wallet(tx, [eth]);
      await importInto(tx, who, 'etherscan', [
        {
          externalId: '0xplain',
          occurredAt: AT,
          kind: 'transfer_out',
          primary: { tokenIdentity: coin(eth), quantity: '-1' },
        },
      ]);
      expect((await ledger(tx, who.userId)).map((r) => [r.kind, r.swapGroupId])).toEqual([
        ['transfer_out', null],
      ]);
    });
  });
});

describe('legacyTransactionBatch through ingest — the holdings it lands on', () => {
  test('a conversion lands on both cash holdings, with the fee on one only (SC-1452)', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const [usd, cad] = [freshSymbol(), freshSymbol()];
      await importInto(tx, who, 'kraken-api', [
        {
          externalId: 'F-1',
          occurredAt: AT,
          kind: 'buy',
          primary: { tokenIdentity: coin(usd), quantity: '1000', tokenType: 'fiat' },
          counter: { tokenIdentity: coin(cad), quantity: '-1370', tokenType: 'fiat' },
          fee: { tokenIdentity: coin(usd), quantity: '-2', tokenType: 'fiat' },
        },
        {
          externalId: 'F-1:quote',
          occurredAt: AT,
          kind: 'sell',
          primary: { tokenIdentity: coin(cad), quantity: '-1370', tokenType: 'fiat' },
          counter: { tokenIdentity: coin(usd), quantity: '1000', tokenType: 'fiat' },
        },
      ]);
      const rows = await ledger(tx, who.userId);
      // Kraken reports quantities gross of the fee, so the USD fee also
      // leaves as its own row (SC-1486); this test is about the legs.
      expect(
        rows.filter((r) => r.kind !== 'fee').map((r) => [r.holding, r.kind, r.quantity])
      ).toEqual([
        [usd, 'buy', '1000'],
        [cad, 'sell', '-1370'],
      ]);
      expect(rows.filter((r) => r.feeQuantity).map((r) => r.holding)).toEqual([usd]);
    });
  });

  // Review Focus 5, and the D-4 quirk kept until A5: the import's own matching
  // falls back to the row a person keeps, writes onto it, and makes it a feed.
  test('a tx import into an account holding only a manual row lands on it and flips it to feed', async () => {
    await withTestDb(async (tx) => {
      const who = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const manual = await makeHolding(tx, {
        ...who,
        tokenId: token.id,
        balance: '5',
        source: 'manual',
        kind: 'snapshot',
        startsAt: FETCHED,
      });
      const result = await importInto(tx, who, 'kraken-api', [
        {
          externalId: 'dep-1',
          occurredAt: AT,
          kind: 'deposit',
          primary: { tokenIdentity: coin(token.symbol), quantity: '1' },
        },
      ]);
      const holdings = await holdingsOf(tx, who.accountId);
      expect(holdings.map((h) => [h.id, h.kind, h.source, h.balance, h.startsAt])).toEqual([
        [manual.id, 'feed', 'manual', '5', AT],
      ]);
      expect((await ledger(tx, who.userId)).map((r) => r.holdingId)).toEqual([manual.id]);
      expect(result.createdHoldingIds).toEqual([]);
    });
  });
});
