import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { DeleteHoldingUseCase } from '../../src/use-cases/DeleteHoldingUseCase';
import { committedRows } from '../../test/helpers/committed-rows';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

/**
 * A5 #9: deleting a feed holding hides it, because its feed would bring it
 * back as an empty row and the evidence would be gone; a person's snapshot is
 * theirs, and deleting it removes it. The hide records the balance it was
 * hidden at, which is what a later rise is measured against.
 *
 * The use case opens its own transaction, so the rows are committed and dropped.
 */

const rows = committedRows();
afterEach(rows.drop);

async function holdingWith(shape: {
  source: string;
  kind: 'feed' | 'snapshot';
  balance: string;
}): Promise<{ userId: string; holdingId: string }> {
  return getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    rows.users.push(user.id);
    // Upserted onto a seeded code, so no institution type outlives the test.
    const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
    const institution = await makeInstitution(tx, { typeId: type.id });
    rows.institutions.push(institution.id);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    rows.tokens.push(token.id);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      ...shape,
    });
    await makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId: holding.id,
      tokenId: token.id,
      kind: 'deposit',
      quantity: shape.balance,
    });
    return { userId: user.id, holdingId: holding.id };
  });
}

async function stored(holdingId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  return row;
}

async function ledgerRows(holdingId: string): Promise<number> {
  return (
    await getDb()
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.holdingId, holdingId))
  ).length;
}

const useCase = () => Container.get(DeleteHoldingUseCase);

describe('DeleteHoldingUseCase (A5 #9)', () => {
  test.each([
    ['an exchange import', 'import_ibkr'],
    ['an exchange sync', 'sync_exchange_balances'],
    ['a wallet sync', 'blockchain'],
    ["a person's row a feed took over", 'manual'],
  ])(
    'a feed holding from %s is hidden by its owner at its balance, and its ledger stays',
    async (_name, source) => {
      const { userId, holdingId } = await holdingWith({ source, kind: 'feed', balance: '7' });

      const result = await useCase().execute(holdingId, userId);

      expect(result.wasHidden).toBe(true);
      const row = await stored(holdingId);
      expect([row?.isHidden, row?.hiddenBy, row?.hiddenBalance]).toEqual([true, 'user', '7']);
      expect(await ledgerRows(holdingId)).toBe(1);
    }
  );

  test("a person's snapshot is deleted with its ledger", async () => {
    const { userId, holdingId } = await holdingWith({
      source: 'manual',
      kind: 'snapshot',
      balance: '7',
    });

    const result = await useCase().execute(holdingId, userId);

    expect(result.wasHidden).toBe(false);
    expect(await stored(holdingId)).toBeUndefined();
    expect(await ledgerRows(holdingId)).toBe(0);
  });

  test('bringing a hidden holding back forgets who hid it and the balance it was hidden at', async () => {
    const { userId, holdingId } = await holdingWith({
      source: 'import_ibkr',
      kind: 'feed',
      balance: '7',
    });
    await useCase().execute(holdingId, userId);

    await Container.get(HoldingRepository).unhideHolding(holdingId);

    const row = await stored(holdingId);
    expect([row?.isHidden, row?.hiddenBy, row?.hiddenBalance]).toEqual([false, null, null]);
  });
});
