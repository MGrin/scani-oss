/**
 * Ledger labels stay a function of the row's legacy facts (foundation A2 D-5):
 * `relabelEntries` overwrites them from `mapLegacyEntry`, except where a
 * decision or a classification result stands behind them, and `bulkUpsert`
 * re-labels every row it wrote or took over.
 *
 * The `expectLabelsSettled` control is committed rather than held inside
 * `withTestDb`: the helper classifies through its own read-only session, which
 * cannot see a rolled-back wrapper's rows.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import type { NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';
import { expectLabelsSettled } from '../../test/helpers/labels-settled';

const repo = () => Container.get(HoldingTransactionRepository);
const classification = () => Container.get(FoundationClassificationService);
const AT = new Date('2026-07-14T14:30:00Z');

type Holding = Awaited<ReturnType<typeof holdingOf>>;

async function holdingOf(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx, { code: 'bank' });
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  return {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    holdingId: holding.id,
    institutionId: inst.id,
  };
}

async function insertRow(
  tx: DatabaseTransaction,
  h: Holding,
  fields: Partial<NewHoldingTransaction> = {}
) {
  const [row] = await tx
    .insert(schema.holdingTransactions)
    .values({
      userId: h.userId,
      holdingId: h.holdingId,
      tokenId: h.tokenId,
      kind: 'deposit',
      quantity: '1',
      occurredAt: AT,
      source: 'kraken-api',
      externalId: randomUUID(),
      ...fields,
    })
    .returning();
  if (!row) throw new Error('holding_transactions insert failed');
  return row;
}

async function inputFor(tx: DatabaseTransaction, h: Holding, source: string) {
  const [input] = await tx
    .insert(schema.feedInputs)
    .values({ userId: h.userId, accountId: h.accountId, source })
    .returning();
  if (!input) throw new Error('feed_inputs insert failed');
  return input;
}

const t = schema.holdingTransactions;

async function labelsOf(tx: DatabaseTransaction, id: string) {
  const [row] = await tx
    .select({
      ledgerKind: t.ledgerKind,
      kindSubtype: t.kindSubtype,
      groupId: t.groupId,
      feeOf: t.feeOf,
      executionPrice: t.executionPrice,
      executionPriceTokenId: t.executionPriceTokenId,
      kindOrigin: t.kindOrigin,
      inputId: t.inputId,
    })
    .from(t)
    .where(eq(t.id, id));
  if (!row) throw new Error(`no holding_transactions row ${id}`);
  return row;
}

const UNLABELLED = {
  ledgerKind: null,
  kindSubtype: null,
  groupId: null,
  feeOf: null,
  executionPrice: null,
  executionPriceTokenId: null,
  kindOrigin: null,
  inputId: null,
};

describe('relabelEntries', () => {
  test('relabelEntries writes the D-5 mapping', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      const usd = await makeToken(tx);
      const input = await inputFor(tx, h, 'kraken-api');
      const swapGroupId = randomUUID();
      const row = await insertRow(tx, h, {
        kind: 'buy',
        swapGroupId,
        priceNative: '50000.10',
        priceNativeTokenId: usd.id,
        inputId: input.id,
      });

      expect(await repo().relabelEntries(h.userId, [row.id], tx)).toBe(1);

      expect(await labelsOf(tx, row.id)).toEqual({
        ledgerKind: 'trade_leg',
        kindSubtype: null,
        groupId: swapGroupId,
        feeOf: null,
        executionPrice: '50000.10',
        executionPriceTokenId: usd.id,
        kindOrigin: 'source',
        inputId: input.id,
      });
      // It returns the rows it changed, and a second pass changes none.
      expect(await repo().relabelEntries(h.userId, [row.id], tx)).toBe(0);
    });
  });

  test('relabelEntries overwrites a stale label', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      const row = await insertRow(tx, h, {
        kind: 'deposit',
        ledgerKind: 'inflow',
        kindOrigin: 'source',
      });
      const transferGroupId = randomUUID();
      await tx.update(t).set({ transferGroupId }).where(eq(t.id, row.id));

      expect(await repo().relabelEntries(h.userId, [row.id], tx)).toBe(1);

      expect(await labelsOf(tx, row.id)).toEqual({
        ...UNLABELLED,
        ledgerKind: 'transfer_in',
        groupId: transferGroupId,
        kindOrigin: 'source',
      });
    });
  });

  test('relabelEntries writes NULL into every label of a row the mapping excludes', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      const input = await inputFor(tx, h, 'kraken-api');
      const row = await insertRow(tx, h, {
        kind: 'correction',
        ledgerKind: 'inflow',
        kindSubtype: 'reward',
        groupId: randomUUID(),
        kindOrigin: 'source',
        inputId: input.id,
      });

      expect(await repo().relabelEntries(h.userId, [row.id], tx)).toBe(1);

      expect(await labelsOf(tx, row.id)).toEqual({ ...UNLABELLED, inputId: input.id });
    });
  });

  test('relabelEntries leaves a row with a decision_id, and a row with kind_origin rule or mirror', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      const [decision] = await tx
        .insert(schema.judgmentDecisions)
        .values({
          userId: h.userId,
          questionKey: 'relabel-test',
          questionVersion: 1,
          stateHash: randomUUID(),
          modelId: 'test-model',
          answer: 'inflow',
          probabilities: {},
          applied: 'confirmed',
        })
        .returning();
      if (!decision) throw new Error('judgment_decisions insert failed');
      // Every one of these is paired, so D-5 alone would read `transfer_in`.
      const paired = { kind: 'deposit', transferGroupId: randomUUID(), ledgerKind: 'inflow' };
      const rows = [
        await insertRow(tx, h, { ...paired, kindOrigin: 'source', decisionId: decision.id }),
        await insertRow(tx, h, { ...paired, kindOrigin: 'rule' }),
        await insertRow(tx, h, { ...paired, kindOrigin: 'mirror' }),
        await insertRow(tx, h, { ...paired, kindOrigin: 'jev' }),
      ];

      expect(
        await repo().relabelEntries(
          h.userId,
          rows.map((r) => r.id),
          tx
        )
      ).toBe(0);

      const after = await tx
        .select({ ledgerKind: t.ledgerKind, groupId: t.groupId, kindOrigin: t.kindOrigin })
        .from(t)
        .where(
          inArray(
            t.id,
            rows.map((r) => r.id)
          )
        );
      expect(after).toHaveLength(4);
      expect(after.every((r) => r.ledgerKind === 'inflow' && r.groupId === null)).toBe(true);
    });
  });

  test('a rule-labelled row whose label differs from the D-5 mapping is not counted as stale-label', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      // D-5 reads an unpaired deposit as `inflow`; each of these says `transfer_in`.
      const differing = { kind: 'deposit', ledgerKind: 'transfer_in', groupId: randomUUID() };
      await insertRow(tx, h, { ...differing, kindOrigin: 'rule' });
      await insertRow(tx, h, { ...differing, kindOrigin: 'mirror' });
      await insertRow(tx, h, { ...differing, kindOrigin: 'jev' });
      // The control: the same label from the source mapping is stale.
      await insertRow(tx, h, { ...differing, kindOrigin: 'source' });

      const report = await classification().classify({ apply: false, userId: h.userId }, tx);

      expect(report.failedUsers).toEqual([]);
      expect(report.notes['stale-label']).toBe(1);
    });
  });

  test('relabelEntries is scoped to the user', async () => {
    await withTestDb(async (tx) => {
      const mine = await holdingOf(tx);
      const theirs = await holdingOf(tx);
      const row = await insertRow(tx, theirs, { kind: 'deposit' });

      expect(await repo().relabelEntries(mine.userId, [row.id], tx)).toBe(0);
      expect(await labelsOf(tx, row.id)).toEqual(UNLABELLED);

      // The control: the row was relabellable, by its own user.
      expect(await repo().relabelEntries(theirs.userId, [row.id], tx)).toBe(1);
    });
  });
});

describe('bulkUpsert re-labels what it writes', () => {
  test('bulkUpsert re-labels a re-imported row whose kind changed', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      const input = await inputFor(tx, h, 'kraken-api');
      const sent = {
        userId: h.userId,
        holdingId: h.holdingId,
        tokenId: h.tokenId,
        quantity: '1',
        occurredAt: AT,
        source: 'kraken-api',
        externalId: 'kraken-ledger-1',
      };

      const first = await repo().bulkUpsert([{ ...sent, kind: 'deposit', inputId: input.id }], tx);
      const id = first.rows[0]!.id;
      expect(await labelsOf(tx, id)).toEqual({
        ...UNLABELLED,
        ledgerKind: 'inflow',
        kindOrigin: 'source',
        inputId: input.id,
      });

      // A re-import that carries no input leaves the stored one.
      await repo().bulkUpsert([{ ...sent, kind: 'reward' }], tx);

      expect(await labelsOf(tx, id)).toEqual({
        ...UNLABELLED,
        ledgerKind: 'income',
        kindSubtype: 'reward',
        kindOrigin: 'source',
        inputId: input.id,
      });
    });
  });

  test('bulkUpsert re-labels the person row it takes over', async () => {
    await withTestDb(async (tx) => {
      const h = await holdingOf(tx);
      // The SC-1468 adoption shape: an imported arrival takes over the row a
      // person's transfer-review answer wrote for it.
      const answered = {
        userId: h.userId,
        holdingId: h.holdingId,
        tokenId: h.tokenId,
        kind: 'transfer_in',
        quantity: '1000',
        occurredAt: new Date('2025-11-07T10:00:00Z'),
        source: 'transfer-review',
        externalId: 'review-0',
      };
      const [person] = (await repo().bulkUpsert([answered], tx)).rows;
      expect(await labelsOf(tx, person!.id)).toMatchObject({
        ledgerKind: 'transfer_in',
        kindOrigin: 'person',
      });

      await repo().bulkUpsert([{ ...answered, source: 'etherscan', externalId: '0xhash0:in' }], tx);

      const rows = await tx.select().from(t).where(eq(t.holdingId, h.holdingId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: person!.id,
        source: 'etherscan',
        ledgerKind: 'transfer_in',
        kindOrigin: 'source',
      });
    });
  });
});

describe('expectLabelsSettled', () => {
  const createdUserIds: string[] = [];
  const createdTokenIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    const users = createdUserIds.splice(0);
    const tokens = createdTokenIds.splice(0);
    const institutions = createdInstitutionIds.splice(0);
    // Users first: their holdings are what keep the token restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  test('expectLabelsSettled passes after a backfill and fails when a label is stale', async () => {
    const { h, row } = await getDb().transaction(async (tx) => {
      const h = await holdingOf(tx);
      createdUserIds.push(h.userId);
      createdTokenIds.push(h.tokenId);
      createdInstitutionIds.push(h.institutionId);
      const row = await insertRow(tx, h, { kind: 'deposit', source: 'user-entered' });
      return { h, row };
    });

    await classification().classify({ apply: true, userId: h.userId });
    await expectLabelsSettled(h.userId);

    // Paired behind the labels' back: the persisted `inflow` is now stale.
    await getDb().update(t).set({ transferGroupId: randomUUID() }).where(eq(t.id, row.id));

    const report = await classification().classify({ apply: false, userId: h.userId });
    expect(report.notes['stale-label']).toBe(1);
    expect(report.rowsUpdated).toEqual({ holdings: 0, observations: 0, entries: 0 });
    expect(report.failedUsers).toEqual([]);
    await expect(expectLabelsSettled(h.userId)).rejects.toThrow();
  });

  test('linkSettlements re-labels the settlement and fee it links to their trade', async () => {
    const f = await getDb().transaction(async (tx) => {
      const stock = await holdingOf(tx);
      createdUserIds.push(stock.userId);
      createdTokenIds.push(stock.tokenId);
      createdInstitutionIds.push(stock.institutionId);
      const usd = await makeToken(tx);
      createdTokenIds.push(usd.id);
      const cash = await makeHolding(tx, {
        userId: stock.userId,
        accountId: stock.accountId,
        tokenId: usd.id,
      });
      return { userId: stock.userId, stock, usd: usd.id, cash: cash.id };
    });
    const common = { userId: f.userId, occurredAt: AT, source: 'ibkr-api' };
    // The SC-1453 import shape: a trade, and its settlement and fee legs, which
    // name the trade by external id until `linkSettlements` points them at it.
    await repo().bulkUpsert([
      {
        ...common,
        holdingId: f.stock.holdingId,
        tokenId: f.stock.tokenId,
        kind: 'buy',
        quantity: '2',
        externalId: 'ibkr-trade-1',
      },
      {
        ...common,
        holdingId: f.cash,
        tokenId: f.usd,
        kind: 'settle_out',
        quantity: '-1000',
        externalId: 'ibkr-trade-1:settle',
        sourceMetadata: { settles: 'ibkr-trade-1' },
      },
      {
        ...common,
        holdingId: f.cash,
        tokenId: f.usd,
        kind: 'fee',
        quantity: '-1',
        externalId: 'ibkr-trade-1:fee',
        sourceMetadata: { settles: 'ibkr-trade-1' },
      },
    ]);
    // Settles every label linking does not touch: the holdings' kind and the
    // entries' input, which no A2 writer states yet.
    await classification().classify({ apply: true, userId: f.userId });
    await expectLabelsSettled(f.userId);

    expect(await repo().linkSettlements(f.userId)).toBe(2);

    await expectLabelsSettled(f.userId);
  });
});
