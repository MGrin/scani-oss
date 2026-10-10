import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1645: gains by account wrapper are user-wide, so a scope is refused
// rather than silently ignored.

const suffix = randomUUID().slice(0, 8);
let owner: typeof schema.users.$inferSelect;

beforeAll(async () => {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1645-gains-${suffix}@scani.local`, name: 'owner' })
    .returning();
  owner = user!;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, owner.id));
});

describe('portfolio.getGainsByWrapper', () => {
  test('answers four buckets for a user with no accounts', async () => {
    const result = await makeAuthedCaller(owner).portfolio.getGainsByWrapper({
      window: { kind: '1y' },
    });
    expect(result).toMatchObject({ status: 'ok', anyWrapped: false, carriedHoldings: 0 });
    expect(result.status === 'ok' ? result.buckets.map((b) => b.treatment) : []).toEqual([
      'general',
      'deferred',
      'exempt',
      'advantaged',
    ]);
  });

  test('a scope is a readable BAD_REQUEST, not ignored', async () => {
    const call = makeAuthedCaller(owner).portfolio.getGainsByWrapper({
      window: { kind: '1y' },
      scope: { kind: 'account', id: randomUUID() },
    });
    await expect(call).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(call).rejects.toThrow(/user-wide/);
  });
});
