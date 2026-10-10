/**
 * SC-1609: the outbox writer. An event exists exactly when its data does, so
 * it is written only inside the caller's transaction.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { OutboxWriter } from '../../../src/services/outbox/OutboxWriter';
import { withTestDb } from '../../../test/helpers/db';

async function makeUser(tx: DatabaseTransaction): Promise<string> {
  const [usd] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.isActive, true)));
  const [user] = await tx
    .insert(schema.users)
    .values({
      email: `outbox-${randomUUID()}@scani.local`,
      name: 'Outbox',
      baseCurrencyId: usd!.id,
    })
    .returning();
  return user!.id;
}

const holdingChanged = {
  v: 1 as const,
  holdingId: randomUUID(),
  balance: '1.5',
  valueBase: '150.25',
  valuePricedAt: '2026-10-07T08:00:00.000Z',
};

describe('OutboxWriter.append', () => {
  test('writes one row with the type and payload, unpublished, in the caller transaction', async () => {
    await withTestDb(async (tx) => {
      const userId = await makeUser(tx);
      const id = await Container.get(OutboxWriter).append(
        tx,
        userId,
        'holding.changed',
        holdingChanged
      );
      const rows = await tx
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(id);
      expect(rows[0]?.type).toBe('holding.changed');
      expect(rows[0]?.payload).toEqual(holdingChanged);
      expect(rows[0]?.publishedAt).toBeNull();
    });
  });

  test('refuses an event with no user', async () => {
    await withTestDb(async (tx) => {
      const writer = Container.get(OutboxWriter);
      await expect(
        writer.append(tx, null as unknown as string, 'holding.changed', holdingChanged)
      ).rejects.toThrow(/user/i);
      await expect(writer.append(tx, '', 'holding.changed', holdingChanged)).rejects.toThrow(
        /user/i
      );
    });
  });

  test('refuses a payload that is not its type at its version', async () => {
    await withTestDb(async (tx) => {
      const userId = await makeUser(tx);
      const writer = Container.get(OutboxWriter);
      await expect(
        writer.append(tx, userId, 'price.changed', { v: 1, tokenId: randomUUID(), holdingIds: [] })
      ).rejects.toThrow();
      await expect(
        writer.append(tx, userId, 'holding.changed', { ...holdingChanged, v: 2 } as never)
      ).rejects.toThrow();
      const rows = await tx
        .select()
        .from(schema.outboxEvents)
        .where(eq(schema.outboxEvents.userId, userId));
      expect(rows).toHaveLength(0);
    });
  });

  test("accepts the shared Decimal's own output, exponent form included", async () => {
    await withTestDb(async (tx) => {
      const userId = await makeUser(tx);
      const writer = Container.get(OutboxWriter);
      const dust = new Decimal('0.00000001').toString();
      const huge = new Decimal('1e29').toString();
      // The shared Decimal prints these in exponent form; a writer passes them as is.
      expect([dust, huge]).toEqual(['1e-8', '1e+29']);
      for (const delta of [dust, huge, '-1E-8']) {
        await writer.append(tx, userId, 'total.delta', {
          v: 1,
          baseCurrencyId: randomUUID(),
          delta,
        });
      }
      await expect(
        writer.append(tx, userId, 'total.delta', {
          v: 1,
          baseCurrencyId: randomUUID(),
          delta: '1e',
        })
      ).rejects.toThrow();
    });
  });
});
