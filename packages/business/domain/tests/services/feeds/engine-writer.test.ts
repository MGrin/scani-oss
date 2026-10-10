/**
 * A5 D-2: the calculator holds `scani.engine_writer` only around its own
 * statements, so a later write in the same transaction is guarded again.
 */

import { expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { asEngineCalculator } from '../../../src/services/feeds/engine-writer';
import { withTestDb } from '../../../test/helpers/db';
import { guardOff, sqlStateOf } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function holding(tx: Tx) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const row = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '0',
  });
  return row.id;
}

const setBalance = (tx: Tx, id: string, balance: string) =>
  tx.update(schema.holdings).set({ balance }).where(eq(schema.holdings.id, id));

const balanceOf = async (tx: Tx, id: string) =>
  (await tx.select().from(schema.holdings).where(eq(schema.holdings.id, id)))[0]?.balance;

test('a write inside asEngineCalculator lands; the same write after it is refused', async () => {
  await withTestDb(async (tx) => {
    const id = await holding(tx);

    await asEngineCalculator(tx, (calculator) => setBalance(calculator, id, '5'));
    expect(await balanceOf(tx, id)).toBe('5');
    expect(await sqlStateOf(tx, (sp) => setBalance(sp, id, '6'))).toBe('SCE01');
    expect(await balanceOf(tx, id)).toBe('5');
  });
});

test('the setting is reset when the write throws', async () => {
  await withTestDb(async (tx) => {
    const id = await holding(tx);

    await expect(
      asEngineCalculator(tx, async () => {
        throw new Error('the write failed');
      })
    ).rejects.toThrow('the write failed');
    expect(await sqlStateOf(tx, (sp) => setBalance(sp, id, '6'))).toBe('SCE01');
  });
});

test('CONTROL: with the guard off, the same bare write lands', async () => {
  await withTestDb(async (tx) => {
    const id = await holding(tx);
    await guardOff(tx);
    expect(await sqlStateOf(tx, (sp) => setBalance(sp, id, '6'))).toBeUndefined();
    expect(await balanceOf(tx, id)).toBe('6');
  });
});
