import { expect, spyOn, test } from 'bun:test';
import { getDb } from '@scani/db';
import { payments, tokens, users } from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../../src/repositories/PaymentOccurrenceRepository';
import { PaymentService } from '../../../src/services/payments/PaymentService';
import { makeUser, makeVendor } from '../../../test/helpers/factories';
import { makeToken } from '../../../test/helpers/factories-extra';

test('creating a payment rolls back its row when schedule creation fails, then retries cleanly', async () => {
  const db = getDb();
  const { user, vendor, token } = await db.transaction(async (tx) => {
    const user = await makeUser(tx);
    const vendor = await makeVendor(tx, { userId: user.id });
    const token = await makeToken(tx);
    return { user, vendor, token };
  });
  const input = {
    vendorId: vendor.id,
    currencyTokenId: token.id,
    direction: 'outflow' as const,
    kind: 'fixed' as const,
    intervalUnit: 'month' as const,
    intervalCount: 1,
    anchorDate: new Date().toISOString().slice(0, 10),
    expectedAmount: '10',
  };
  const repo = Container.get(PaymentOccurrenceRepository);
  const failure = spyOn(repo, 'bulkUpsert').mockRejectedValueOnce(
    new Error('schedule unavailable')
  );
  try {
    await expect(Container.get(PaymentService).create(user.id, input)).rejects.toThrow(
      'schedule unavailable'
    );
    const rows = await db.select().from(payments).where(eq(payments.userId, user.id));
    expect(rows).toHaveLength(0);
    failure.mockRestore();
    const created = await Container.get(PaymentService).create(user.id, input);
    expect(await repo.findByPaymentId(created.id)).not.toHaveLength(0);
    expect(await db.select().from(payments).where(eq(payments.userId, user.id))).toHaveLength(1);
  } finally {
    failure.mockRestore();
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(tokens).where(eq(tokens.id, token.id));
  }
});
