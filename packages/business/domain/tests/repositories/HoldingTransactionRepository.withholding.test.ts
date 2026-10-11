/**
 * `linkWithholding` points a dividend's withholding tax at the dividend it was
 * taken from (SC-1644), as a `source_metadata.feeOf` fact the D-5 mapping turns
 * into `fee_of`. A fact, because `relabelEntries` rewrites `fee_of` from the
 * facts on every re-import, and a broker re-sends its whole statement period.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import type { NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);
const t = schema.holdingTransactions;

// Invented securities: the `ZZ` country code is not assigned.
const ACME = { symbol: 'ACME', isin: 'ZZ0000000017' };
const GLOBEX = { symbol: 'GLOBEX', isin: 'ZZ0000000025' };
const PAY_DAY = new Date('2026-03-12T20:20:00Z');

type Cash = { userId: string; holdingId: string; tokenId: string };

async function cashHolding(tx: DatabaseTransaction): Promise<Cash> {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx, { code: 'broker' });
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
  });
  return { userId: user.id, holdingId: holding.id, tokenId: token.id };
}

function row(cash: Cash, fields: Partial<NewHoldingTransaction>): NewHoldingTransaction {
  return {
    userId: cash.userId,
    holdingId: cash.holdingId,
    tokenId: cash.tokenId,
    kind: 'reward',
    quantity: '1',
    occurredAt: PAY_DAY,
    source: 'ibkr-api',
    externalId: randomUUID(),
    ...fields,
  };
}

const dividend = (cash: Cash, paidBy: object, fields: Partial<NewHoldingTransaction> = {}) =>
  row(cash, {
    kind: 'reward',
    quantity: '24',
    sourceMetadata: { income: 'dividend', paidBy },
    ...fields,
  });

const withholding = (cash: Cash, paidBy: object, fields: Partial<NewHoldingTransaction> = {}) =>
  row(cash, { kind: 'fee', quantity: '-3.6', sourceMetadata: { paidBy }, ...fields });

async function write(tx: DatabaseTransaction, rows: NewHoldingTransaction[]) {
  return (await repo().bulkUpsert(rows, tx)).rows;
}

async function linkOf(tx: DatabaseTransaction, id: string) {
  const [stored] = await tx
    .select({ feeOf: t.feeOf, ledgerKind: t.ledgerKind, sourceMetadata: t.sourceMetadata })
    .from(t)
    .where(eq(t.id, id));
  if (!stored) throw new Error(`no holding_transactions row ${id}`);
  return {
    feeOf: stored.feeOf,
    ledgerKind: stored.ledgerKind,
    fact: (stored.sourceMetadata as { feeOf?: string } | null)?.feeOf,
  };
}

describe('linkWithholding (SC-1644)', () => {
  test('a withholding is linked to the dividend it was taken from', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      const [div, tax] = await write(tx, [
        dividend(cash, ACME),
        withholding(cash, ACME, { occurredAt: new Date('2026-03-12T23:59:00Z') }),
      ]);

      expect(await repo().linkWithholding(cash.userId, tx)).toBe(1);

      expect(await linkOf(tx, tax!.id)).toEqual({
        feeOf: div!.id,
        ledgerKind: 'fee',
        fact: div!.id,
      });
      expect((await linkOf(tx, div!.id)).feeOf).toBeNull();
    });
  });

  test('two dividends on one day each take their own withholding', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      const [acme, globex, acmeTax, globexTax] = await write(tx, [
        dividend(cash, ACME),
        dividend(cash, GLOBEX),
        withholding(cash, ACME),
        withholding(cash, GLOBEX),
      ]);

      expect(await repo().linkWithholding(cash.userId, tx)).toBe(2);

      expect((await linkOf(tx, acmeTax!.id)).feeOf).toBe(acme!.id);
      expect((await linkOf(tx, globexTax!.id)).feeOf).toBe(globex!.id);
    });
  });

  test('a dividend and a payment in lieu on one day each take their own withholding', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      const inLieu = { inLieu: true };
      const [paid, lent, paidTax, lentTax] = await write(tx, [
        dividend(cash, ACME),
        dividend(cash, ACME, {
          sourceMetadata: { income: 'dividend', paidBy: ACME, ...inLieu },
        }),
        withholding(cash, ACME),
        withholding(cash, ACME, { sourceMetadata: { paidBy: ACME, ...inLieu } }),
      ]);

      expect(await repo().linkWithholding(cash.userId, tx)).toBe(2);

      expect((await linkOf(tx, paidTax!.id)).feeOf).toBe(paid!.id);
      expect((await linkOf(tx, lentTax!.id)).feeOf).toBe(lent!.id);
    });
  });

  test('a security named by symbol alone still links', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      const [div, tax] = await write(tx, [
        dividend(cash, { symbol: 'ACME' }),
        withholding(cash, { symbol: 'ACME' }),
      ]);

      expect(await repo().linkWithholding(cash.userId, tx)).toBe(1);
      expect((await linkOf(tx, tax!.id)).feeOf).toBe(div!.id);
    });
  });

  test('no dividend that day, or two that match, leaves the withholding unlinked', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      const [, , lone, ambiguous] = await write(tx, [
        dividend(cash, GLOBEX),
        dividend(cash, GLOBEX, { externalId: 'globex-again' }),
        withholding(cash, ACME),
        withholding(cash, GLOBEX),
      ]);
      const [nextDay] = await write(tx, [
        withholding(cash, GLOBEX, { occurredAt: new Date('2026-03-13T00:00:00Z') }),
      ]);

      expect(await repo().linkWithholding(cash.userId, tx)).toBe(0);

      for (const tax of [lone, ambiguous, nextDay]) {
        expect(await linkOf(tx, tax!.id)).toEqual({
          feeOf: null,
          ledgerKind: 'fee',
          fact: undefined,
        });
      }
    });
  });

  test("only the user's own rows are linked, and only the user named", async () => {
    await withTestDb(async (tx) => {
      const mine = await cashHolding(tx);
      const theirs = await cashHolding(tx);
      const [, theirTax] = await write(tx, [dividend(theirs, ACME), withholding(theirs, ACME)]);
      const [myTax] = await write(tx, [withholding(mine, ACME)]);

      expect(await repo().linkWithholding(mine.userId, tx)).toBe(0);

      expect((await linkOf(tx, myTax!.id)).feeOf).toBeNull();
      expect((await linkOf(tx, theirTax!.id)).feeOf).toBeNull();
    });
  });

  test('a re-sent withholding keeps its link (feeds condition 4)', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      const tax = withholding(cash, ACME, { externalId: 'ibkr-tax-1' });
      const [div] = await write(tx, [dividend(cash, ACME), tax]);
      await repo().linkWithholding(cash.userId, tx);

      // The next sync sends the same statement row, which re-labels it.
      const [resent] = await write(tx, [{ ...tax, sourceMetadata: { paidBy: ACME } }]);

      expect(await linkOf(tx, resent!.id)).toEqual({
        feeOf: div!.id,
        ledgerKind: 'fee',
        fact: div!.id,
      });
    });
  });

  test('a second sweep links nothing more', async () => {
    await withTestDb(async (tx) => {
      const cash = await cashHolding(tx);
      await write(tx, [dividend(cash, ACME), withholding(cash, ACME)]);

      expect(await repo().linkWithholding(cash.userId, tx)).toBe(1);
      expect(await repo().linkWithholding(cash.userId, tx)).toBe(0);
    });
  });
});
