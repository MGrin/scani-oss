import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { PaymentRepository } from '../../src/repositories/PaymentRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makePayment } from '../../test/helpers/factories-extra';

const repo = () => Container.get(PaymentRepository);

describe('PaymentRepository', () => {
  test('findByIdAndUser returns the payment when it belongs to the user', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const payment = await makePayment(tx, { userId: user.id });

      const found = await repo().findByIdAndUser(payment.id, user.id, tx);
      expect(found?.id).toBe(payment.id);
    });
  });

  test('findByIdAndUser returns null for a payment belonging to another user', async () => {
    await withTestDb(async (tx) => {
      const owner = await makeUser(tx);
      const other = await makeUser(tx);
      const payment = await makePayment(tx, { userId: owner.id });

      expect(await repo().findByIdAndUser(payment.id, other.id, tx)).toBeNull();
    });
  });

  test('findByIdAndUser returns null for a non-existent id', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      expect(
        await repo().findByIdAndUser('00000000-0000-0000-0000-000000000000', user.id, tx)
      ).toBeNull();
    });
  });

  test("findByUser returns only that user's payments", async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const paymentA = await makePayment(tx, { userId: userA.id });
      await makePayment(tx, { userId: userB.id });

      const rows = await repo().findByUser(userA.id, tx);
      expect(rows.map((p) => p.id)).toEqual([paymentA.id]);
    });
  });
});
