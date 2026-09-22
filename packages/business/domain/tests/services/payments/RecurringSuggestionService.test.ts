import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
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
      await pay('Old Landlord', ['2026-01-09', '2026-02-10', '2026-03-02'], '3250');
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
