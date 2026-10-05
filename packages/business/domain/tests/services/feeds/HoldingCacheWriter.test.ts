/**
 * `HoldingCacheWriter.apply` against Postgres: the one writer of
 * `holdings.balance`, so what it does to a hidden holding is what every sync,
 * edit and transfer does (SC-1557).
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function hiddenHolding(tx: Tx, hiddenBy: 'auto' | 'user' | null) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '0',
    isHidden: true,
    hiddenBy,
  });
  return { userId: user.id, holdingId: holding.id };
}

async function write(tx: Tx, hiddenBy: 'auto' | 'user' | null, balance: string) {
  const { userId, holdingId } = await hiddenHolding(tx, hiddenBy);
  await Container.get(HoldingCacheWriter).apply(userId, [{ holdingId, balance }], tx);
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error('the holding is gone');
  return { balance: row.balance, isHidden: row.isHidden, hiddenBy: row.hiddenBy };
}

describe('HoldingCacheWriter — a holding the sweep hid (SC-1557)', () => {
  test('is shown again by a non-zero balance, and still reads as swept', async () => {
    await withTestDb(async (tx) => {
      expect(await write(tx, 'auto', '12.5')).toEqual({
        balance: '12.5',
        isHidden: false,
        hiddenBy: 'auto',
      });
    });
  });

  test('is shown again by a negative balance', async () => {
    await withTestDb(async (tx) => {
      expect((await write(tx, 'auto', '-3')).isHidden).toBe(false);
    });
  });

  test('stays hidden when the balance written is zero, however it is spelled', async () => {
    await withTestDb(async (tx) => {
      expect((await write(tx, 'auto', '0')).isHidden).toBe(true);
      expect((await write(tx, 'auto', '0.000')).isHidden).toBe(true);
    });
  });
});

describe('HoldingCacheWriter — a holding that is shown (SC-1559)', () => {
  // The other direction: the writer shows and never hides, whatever it writes.
  test('stays shown when the balance written is zero, swept before or not', async () => {
    await withTestDb(async (tx) => {
      for (const hiddenBy of ['auto', null] as const) {
        const { userId, holdingId } = await hiddenHolding(tx, hiddenBy);
        await tx
          .update(schema.holdings)
          .set({ isHidden: false, balance: '9' })
          .where(eq(schema.holdings.id, holdingId));

        await Container.get(HoldingCacheWriter).apply(userId, [{ holdingId, balance: '0' }], tx);

        const [row] = await tx
          .select()
          .from(schema.holdings)
          .where(eq(schema.holdings.id, holdingId));
        expect({ balance: row?.balance, isHidden: row?.isHidden }).toEqual({
          balance: '0',
          isHidden: false,
        });
      }
    });
  });
});

describe('HoldingCacheWriter — a holding its owner hid (SC-1557)', () => {
  test('stays hidden when it gets a balance', async () => {
    await withTestDb(async (tx) => {
      expect(await write(tx, 'user', '12.5')).toEqual({
        balance: '12.5',
        isHidden: true,
        hiddenBy: 'user',
      });
    });
  });

  test('stays hidden when nothing says who hid it', async () => {
    await withTestDb(async (tx) => {
      expect((await write(tx, null, '12.5')).isHidden).toBe(true);
    });
  });
});
