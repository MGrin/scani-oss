import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  RecurringSuggestionService,
  SuggestionNotFoundError,
} from '../../../src/services/payments/RecurringSuggestionService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser, makeVendor } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makePayment,
  makePaymentOccurrence,
  makeToken,
} from '../../../test/helpers/factories-extra';

const AS_OF = new Date('2026-08-26T12:00:00Z');
const MONTHS = ['2026-05-03', '2026-06-02', '2026-07-03', '2026-08-01'];

async function seed(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const gbp = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: gbp.id,
  });
  const pay = (
    counterparty: string,
    dates: string[],
    amount: string,
    extra: Partial<typeof schema.holdingTransactions.$inferInsert> = {}
  ) =>
    Promise.all(
      dates.map((d) =>
        makeHoldingTransaction(tx, {
          userId: user.id,
          holdingId: holding.id,
          kind: 'withdraw',
          quantity: `-${amount}`,
          occurredAt: new Date(`${d}T12:00:00Z`),
          counterparty,
          ...extra,
        })
      )
    );
  return { user, gbp, pay };
}

const service = () => Container.get(RecurringSuggestionService);

describe('RecurringSuggestionService', () => {
  test('suggests an active monthly payment, with the dates and amounts it matched', async () => {
    await withTestDb(async (tx) => {
      const { user, gbp, pay } = await seed(tx);
      await pay('Gym Ltd', MONTHS, '49.99');

      const [s, ...rest] = await service().list(user.id, AS_OF, tx);
      expect(rest).toEqual([]);
      expect(s).toMatchObject({
        counterparty: 'Gym Ltd',
        currencyTokenId: gbp.id,
        amount: '49.99',
        anchorDate: '2026-08-01',
      });
      expect(s?.evidence.map((e) => [e.date, e.amount])).toEqual(MONTHS.map((d) => [d, '49.99']));
    });
  });

  test('moves between own accounts and ended series are not suggested', async () => {
    await withTestDb(async (tx) => {
      const { user, pay } = await seed(tx);
      await pay('Me Savings', MONTHS, '500', { transferReview: 'internal' });
      await pay('Old Landlord', ['2026-01-09', '2026-02-10', '2026-03-02'], '120');
      expect(await service().list(user.id, AS_OF, tx)).toEqual([]);
    });
  });

  // SC-1325: statement rows now carry a payee, so a monthly move to your own
  // savings pot that the linker already paired would otherwise read as a bill.
  test('a payment already paired with its arrival is not suggested', async () => {
    await withTestDb(async (tx) => {
      const { user, pay } = await seed(tx);
      for (const d of MONTHS) {
        await pay('SAVINGS POT', [d], '200', { transferGroupId: crypto.randomUUID() });
      }
      expect(await service().list(user.id, AS_OF, tx)).toEqual([]);
    });
  });

  test('a dismissed suggestion stays dismissed after the next payment lands', async () => {
    await withTestDb(async (tx) => {
      const { user, gbp, pay } = await seed(tx);
      await pay('Gym Ltd', MONTHS.slice(0, 3), '49.99');
      const [s] = await service().list(user.id, new Date('2026-07-20T00:00:00Z'), tx);
      expect(s).toBeDefined();

      await service().dismiss(user.id, s?.counterpartyKey as string, gbp.id, tx);
      await pay('Gym Ltd', ['2026-08-01'], '50.49');

      expect(await service().list(user.id, AS_OF, tx)).toEqual([]);
    });
  });

  test('a payment already covering the payee hides it; so does a matched occurrence', async () => {
    await withTestDb(async (tx) => {
      const { user, gbp, pay } = await seed(tx);
      await pay('Gym Ltd', MONTHS, '49.99');
      const rows = await pay('Power Co', MONTHS, '80');

      const gym = await makeVendor(tx, { userId: user.id, displayName: 'GYM' });
      await makePayment(tx, { userId: user.id, vendorId: gym.id, currencyTokenId: gbp.id });
      const other = await makePayment(tx, { userId: user.id, currencyTokenId: gbp.id });
      await makePaymentOccurrence(tx, {
        paymentId: other.id,
        dueDate: '2026-06-01',
        status: 'matched',
        matchedTransactionId: rows[1]?.id,
      });

      expect(await service().list(user.id, AS_OF, tx)).toEqual([]);
    });
  });

  test('accept writes one detected payment from the server-side series, then stops suggesting it', async () => {
    await withTestDb(async (tx) => {
      const { user, gbp, pay } = await seed(tx);
      await pay('Gym Ltd', MONTHS, '49.99');
      const [s] = await service().list(user.id, AS_OF, tx);

      const payment = await service().accept(
        user.id,
        s?.counterpartyKey as string,
        gbp.id,
        AS_OF,
        tx
      );

      expect(payment).toMatchObject({
        direction: 'outflow',
        kind: 'fixed',
        expectedAmount: '49.99',
        currencyTokenId: gbp.id,
        intervalUnit: 'month',
        intervalCount: 1,
        anchorDate: '2026-08-01',
        origin: 'detected',
      });
      const [vendor] = await tx
        .select()
        .from(schema.vendors)
        .where(eq(schema.vendors.id, payment.vendorId));
      expect(vendor?.displayName).toBe('Gym Ltd');
      expect(await service().list(user.id, AS_OF, tx)).toEqual([]);
    });
  });

  describe('a payee paid in coins worth the same is one series', () => {
    async function usdOf(tx: DatabaseTransaction) {
      const [usd] = await tx
        .select({ id: schema.tokens.id })
        .from(schema.tokens)
        .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokenTypes.code, 'fiat')));
      if (!usd) throw new Error('the fiat USD is seeded by migration');
      return usd;
    }
    async function coins(tx: DatabaseTransaction, userId: string, prices: string[]) {
      const [usd] = await tx
        .select()
        .from(schema.tokens)
        .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokenTypes.code, 'fiat')));
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId, institutionId: institution.id });
      return Promise.all(
        prices.map(async (price) => {
          const token = await makeToken(tx);
          await tx.insert(schema.tokenPrices).values({
            tokenId: token.id,
            baseTokenId: usd?.tokens.id as string,
            price,
            timestamp: new Date('2026-08-25T00:00:00Z'),
            granularity: 'daily',
            source: 'test',
          });
          const holding = await makeHolding(tx, {
            userId,
            accountId: account.id,
            tokenId: token.id,
          });
          return { token, holding };
        })
      );
    }
    const payIn = (tx: DatabaseTransaction, userId: string, holdingId: string, d: string) =>
      makeHoldingTransaction(tx, {
        userId,
        holdingId,
        kind: 'transfer_out',
        transferReview: 'left_control',
        quantity: '-120',
        occurredAt: new Date(`${d}T12:00:00Z`),
        counterparty: '0xabc',
      });

    test('USDT one month and USDC the next is one suggestion, in the coin paid last', async () => {
      await withTestDb(async (tx) => {
        const { user } = await seed(tx);
        const [usdt, usdc] = await coins(tx, user.id, ['0.995', '1.005']);
        for (const [i, d] of MONTHS.entries()) {
          await payIn(tx, user.id, (i % 2 ? usdc : usdt)?.holding.id as string, d);
        }

        const [s, ...rest] = await service().list(user.id, AS_OF, tx);
        expect(rest).toEqual([]);
        expect(s).toMatchObject({
          amount: '120',
          currencyTokenId: usdc?.token.id,
          anchorDate: '2026-08-01',
        });
        expect(s?.evidence.map((e) => e.currencyTokenId)).toEqual(
          [usdt, usdc, usdt, usdc].map((c) => c?.token.id as string)
        );
      });
    });

    // Foundation A3, Task 7: the coins are compared in the fiat USD their
    // prices are stored against, whatever else carries that symbol.
    test('a newer crypto token named USD does not become the currency the coins are compared in', async () => {
      await withTestDb(async (tx) => {
        const { user } = await seed(tx);
        const [usdt, usdc] = await coins(tx, user.id, ['0.995', '1.005']);
        await makeToken(tx, { symbol: 'USD', name: 'A coin named USD' });
        for (const [i, d] of MONTHS.entries()) {
          await payIn(tx, user.id, (i % 2 ? usdc : usdt)?.holding.id as string, d);
        }

        const [s, ...rest] = await service().list(user.id, AS_OF, tx);
        expect(rest).toEqual([]);
        expect(s).toMatchObject({ amount: '120', currencyTokenId: usdc?.token.id });
      });
    });

    // A catalogue with no fiat USD is a broken install. The coins went
    // uncompared, which hid it.
    test('with no fiat USD in the catalogue the comparison throws, naming the token', async () => {
      await withTestDb(async (tx) => {
        const { user } = await seed(tx);
        const [usdt, usdc] = await coins(tx, user.id, ['0.995', '1.005']);
        for (const [i, d] of MONTHS.entries()) {
          await payIn(tx, user.id, (i % 2 ? usdc : usdt)?.holding.id as string, d);
        }
        // Renamed, not deleted: the coins' prices are stored against it.
        const fiat = tx
          .select({ id: schema.tokenTypes.id })
          .from(schema.tokenTypes)
          .where(eq(schema.tokenTypes.code, 'fiat'));
        await tx
          .update(schema.tokens)
          .set({ symbol: 'USDGONE' })
          .where(and(eq(schema.tokens.symbol, 'USD'), inArray(schema.tokens.typeId, fiat)));

        await expect(service().list(user.id, AS_OF, tx)).rejects.toThrow('no fiat USD token');
      });
    });

    // Foundation A3, Task 16: compared through `PriceReader`, so a rate stored
    // the other way round prices a coin as a direct one does.
    test('a coin priced only by USD’s price in it is compared too', async () => {
      await withTestDb(async (tx) => {
        const { user } = await seed(tx);
        const [direct, inverse] = await coins(tx, user.id, ['2', '2']);
        // The second coin's direct row becomes the USD priced in the coin.
        await tx
          .update(schema.tokenPrices)
          .set({
            tokenId: (await usdOf(tx)).id,
            baseTokenId: inverse?.token.id as string,
            price: '0.5',
          })
          .where(eq(schema.tokenPrices.tokenId, inverse?.token.id as string));
        for (const [i, d] of MONTHS.entries()) {
          await payIn(tx, user.id, (i % 2 ? inverse : direct)?.holding.id as string, d);
        }

        const [s, ...rest] = await service().list(user.id, AS_OF, tx);
        expect(rest).toEqual([]);
        expect(s).toMatchObject({ amount: '120', currencyTokenId: inverse?.token.id });
      });
    });

    test('a coin worth twice as much is not merged, and dismissing covers both coins', async () => {
      await withTestDb(async (tx) => {
        const { user } = await seed(tx);
        const [usdt, usdc, other] = await coins(tx, user.id, ['1', '1', '2']);
        for (const [i, d] of MONTHS.entries()) {
          await payIn(tx, user.id, (i % 2 ? other : usdt)?.holding.id as string, d);
        }
        expect(await service().list(user.id, AS_OF, tx)).toEqual([]);

        // USDT already paid May and July above; a USDC June closes the gap.
        await payIn(tx, user.id, usdc?.holding.id as string, '2026-06-03');
        const [s] = await service().list(user.id, new Date('2026-07-20T00:00:00Z'), tx);
        expect(s?.currencyTokenId).toBe(usdt?.token.id);
        await service().dismiss(
          user.id,
          s?.counterpartyKey as string,
          usdt?.token.id as string,
          tx
        );
        await payIn(tx, user.id, usdc?.holding.id as string, '2026-08-02');
        expect(await service().list(user.id, AS_OF, tx)).toEqual([]);
      });
    });
  });

  test('accept refuses a key that is not currently suggested, and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const { user, gbp } = await seed(tx);
      await expect(service().accept(user.id, 'nobody', gbp.id, AS_OF, tx)).rejects.toBeInstanceOf(
        SuggestionNotFoundError
      );
      const payments = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.userId, user.id));
      expect(payments).toEqual([]);
    });
  });
});
