/**
 * The one definition of "currencies in use" (foundation A3, Task 8; D-6):
 * base, payment and vault currencies, and every currency a held token's manual
 * price is quoted in. The rule lives in SQL, so it is asserted against the
 * database.
 *
 * Each assertion is over the tokens made in the test, so it holds whatever
 * else the database holds.
 */

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makePayment,
  makeToken,
} from '../../test/helpers/factories-extra';

const AT = new Date('2026-03-01T10:00:00Z');

async function hold(tx: DatabaseTransaction, userId: string, tokenId: string): Promise<void> {
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  await makeHolding(tx, { userId, accountId: account.id, tokenId });
}

async function price(
  tx: DatabaseTransaction,
  tokenId: string,
  baseTokenId: string,
  source: string
): Promise<void> {
  await tx
    .insert(schema.tokenPrices)
    .values({ tokenId, baseTokenId, price: '10', timestamp: AT, source });
}

describe('TokenRepository.findCurrencyTokenIdsInUse', () => {
  test('base, payment and vault currencies, and the currency of a held token’s manual price', async () => {
    await withTestDb(async (tx) => {
      const base = await makeToken(tx);
      const payment = await makeToken(tx);
      const vault = await makeToken(tx);
      const manualQuote = await makeToken(tx);
      const user = await makeUser(tx, { baseCurrencyId: base.id });
      await makePayment(tx, { userId: user.id, currencyTokenId: payment.id });
      await tx.insert(schema.vaults).values({
        userId: user.id,
        name: 'A vault',
        targetAmount: '1000',
        currencyId: vault.id,
        color: '#3b82f6',
      });
      const held = await makeToken(tx);
      await hold(tx, user.id, held.id);
      await price(tx, held.id, manualQuote.id, 'manual');

      // CONTROLS, none of them in use.
      const nobodyUses = await makeToken(tx);
      // A provider's quote of a held token names its base, which is not a person's currency.
      const providerBase = await makeToken(tx);
      await price(tx, held.id, providerBase.id, 'coingecko');
      // A manual price on a token nobody holds.
      const unheld = await makeToken(tx);
      const unheldQuote = await makeToken(tx);
      await price(tx, unheld.id, unheldQuote.id, 'manual');

      const inUse = await new TokenRepository().findCurrencyTokenIdsInUse(tx);

      const ours = [base, payment, vault, manualQuote, held, nobodyUses, providerBase, unheldQuote];
      expect(new Set(ours.map((t) => t.id).filter((id) => inUse.includes(id)))).toEqual(
        new Set([base.id, payment.id, vault.id, manualQuote.id])
      );
      expect(new Set(inUse).size).toBe(inUse.length);
    });
  });

  test('a currency used twice is named once', async () => {
    await withTestDb(async (tx) => {
      const currency = await makeToken(tx);
      const first = await makeUser(tx, { baseCurrencyId: currency.id });
      await makeUser(tx, { baseCurrencyId: currency.id });
      await makePayment(tx, { userId: first.id, currencyTokenId: currency.id });

      const inUse = await new TokenRepository().findCurrencyTokenIdsInUse(tx);

      expect(inUse.filter((id) => id === currency.id)).toEqual([currency.id]);
    });
  });
});
