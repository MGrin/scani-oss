import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);
const AT = new Date('2026-07-14T14:30:00Z');

async function makeBrokerAccount(tx: DatabaseTransaction, userId: string) {
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  return makeAccount(tx, { userId, institutionId: inst.id });
}

async function fixture(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const account = await makeBrokerAccount(tx, user.id);
  const voo = await makeToken(tx);
  const usd = await makeToken(tx);
  const stock = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: voo.id });
  const cash = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
  return { userId: user.id, voo: voo.id, usd: usd.id, stock: stock.id, cash: cash.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function importRows(f: Fixture, over: { stock?: string; cash?: string } = {}) {
  const stock = over.stock ?? f.stock;
  const cash = over.cash ?? f.cash;
  const common = { userId: f.userId, occurredAt: AT, source: 'ibkr-api' };
  return [
    {
      ...common,
      holdingId: stock,
      tokenId: f.voo,
      kind: 'buy',
      quantity: '2',
      counterTokenId: f.usd,
      counterQuantity: '-1000',
      feeTokenId: f.usd,
      feeQuantity: '-1',
      externalId: 'ibkr-trade-1',
    },
    {
      ...common,
      holdingId: cash,
      tokenId: f.usd,
      kind: 'settle_out',
      quantity: '-1000',
      externalId: 'ibkr-trade-1:settle',
      sourceMetadata: { settles: 'ibkr-trade-1' },
    },
    {
      ...common,
      holdingId: cash,
      tokenId: f.usd,
      kind: 'fee',
      quantity: '-1',
      externalId: 'ibkr-trade-1:fee',
      sourceMetadata: { settles: 'ibkr-trade-1' },
    },
  ];
}

async function rowsOn(tx: DatabaseTransaction, holdingIds: string[]) {
  return tx
    .select()
    .from(schema.holdingTransactions)
    .where(inArray(schema.holdingTransactions.holdingId, holdingIds));
}

describe('HoldingTransactionRepository.linkSettlements (SC-1453)', () => {
  test('an import run twice leaves one settlement and one fee, both linked to the trade', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      await repo().bulkUpsert(importRows(f), tx);
      expect(await repo().linkSettlements(f.userId, tx)).toBe(2);
      await repo().bulkUpsert(importRows(f), tx);
      expect(await repo().linkSettlements(f.userId, tx)).toBe(0);

      const rows = await rowsOn(tx, [f.stock, f.cash]);
      const trade = rows.find((r) => r.kind === 'buy');
      const legs = rows.filter((r) => r.holdingId === f.cash);
      expect(rows).toHaveLength(3);
      expect(legs.map((r) => r.kind).sort()).toEqual(['fee', 'settle_out']);
      for (const leg of legs) expect(leg.settlesTransactionId).toBe(trade?.id ?? 'missing');
      expect(trade?.settlesTransactionId).toBeNull();
    });
  });

  test('new legs beside a re-sent trade widen the history rebuild to their date (SC-1459)', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const [trade] = importRows(f);
      if (!trade) throw new Error('fixture has no trade');
      await repo().bulkUpsert([trade], tx);

      // The first sync after settlements ship: the trade comes back unchanged
      // and only its legs are new, so they alone must date the rebuild.
      const withLegs = await repo().bulkUpsert(importRows(f), tx);
      expect(withLegs.earliestChangedAt?.toISOString()).toBe(AT.toISOString());

      // Control: the same batch again changes nothing and dates nothing.
      const again = await repo().bulkUpsert(importRows(f), tx);
      expect(again.earliestChangedAt).toBeNull();
    });
  });

  test('deleting the trade deletes its settlement and fee', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const { rows } = await repo().bulkUpsert(importRows(f), tx);
      await repo().linkSettlements(f.userId, tx);
      const trade = rows.find((r) => r.kind === 'buy');
      if (!trade) throw new Error('trade not written');

      await tx
        .delete(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, trade.id));

      expect(await rowsOn(tx, [f.stock, f.cash])).toEqual([]);
    });
  });

  test('a trade with the same external id on another account is never linked', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const other = await makeBrokerAccount(tx, f.userId);
      const otherStock = await makeHolding(tx, {
        userId: f.userId,
        accountId: other.id,
        tokenId: f.voo,
      });
      // Only the trade lands on the other account; the settlement stays on
      // this account's cash, whose own trade is absent.
      await repo().bulkUpsert(importRows(f, { stock: otherStock.id }), tx);

      expect(await repo().linkSettlements(f.userId, tx)).toBe(0);
      const cashRows = await rowsOn(tx, [f.cash]);
      expect(cashRows).toHaveLength(2);
      for (const row of cashRows) expect(row.settlesTransactionId).toBeNull();
    });
  });

  test('a row without a settles marker is never linked', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const [trade] = importRows(f);
      if (!trade) throw new Error('fixture has no trade');
      await repo().bulkUpsert(
        [
          trade,
          {
            userId: f.userId,
            holdingId: f.cash,
            tokenId: f.usd,
            kind: 'fee',
            quantity: '-3',
            occurredAt: AT,
            source: 'ibkr-api',
            externalId: 'ibkr-trade-1',
          },
        ],
        tx
      );
      expect(await repo().linkSettlements(f.userId, tx)).toBe(0);
    });
  });

  // SC-1486: a Kraken deposit's own-token fee row settles the deposit it came
  // with. Unlinked, the cost walk would also fold the fee into the deposit's
  // cost and count it twice.
  test('a fee row settles a non-trade row on its own holding', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const common = {
        userId: f.userId,
        occurredAt: AT,
        source: 'kraken-api',
        holdingId: f.cash,
        tokenId: f.usd,
      };
      await repo().bulkUpsert(
        [
          {
            ...common,
            kind: 'deposit',
            quantity: '525',
            feeTokenId: f.usd,
            feeQuantity: '-3',
            externalId: 'kraken-dep-1',
          },
          {
            ...common,
            kind: 'fee',
            quantity: '-3',
            externalId: 'kraken-dep-1:fee',
            sourceMetadata: { settles: 'kraken-dep-1' },
          },
        ],
        tx
      );
      expect(await repo().linkSettlements(f.userId, tx)).toBe(1);
      const rows = await rowsOn(tx, [f.cash]);
      const deposit = rows.find((r) => r.kind === 'deposit');
      expect(rows.find((r) => r.kind === 'fee')?.settlesTransactionId).toBe(
        deposit?.id ?? 'missing'
      );
    });
  });

  test('control: a fee row never settles a non-trade row on another holding', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const common = { userId: f.userId, occurredAt: AT, source: 'kraken-api' };
      await repo().bulkUpsert(
        [
          {
            ...common,
            holdingId: f.stock,
            tokenId: f.voo,
            kind: 'deposit',
            quantity: '1',
            externalId: 'kraken-dep-2',
          },
          {
            ...common,
            holdingId: f.cash,
            tokenId: f.usd,
            kind: 'fee',
            quantity: '-3',
            externalId: 'kraken-dep-2:fee',
            sourceMetadata: { settles: 'kraken-dep-2' },
          },
        ],
        tx
      );
      expect(await repo().linkSettlements(f.userId, tx)).toBe(0);
    });
  });
});
