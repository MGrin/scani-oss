import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cloudApiKeys, users } from '@scani/db';
import { eq, inArray } from 'drizzle-orm';
import { getCloudDb } from '../../../src/db/connection';
import {
  installCloudDb,
  keysRouter,
  MAX_ACTIVE_KEYS_PER_OWNER,
} from '../../../src/presentation/routers/keys';
import { buildAuthedContext, withCloudUser } from '../../helpers/test-context';

// SC-1353: the hourly quota is per owner now, and minting keys is capped too,
// so an account cannot multiply its budget or its attack surface by keys.
// Revoked keys do not count.

const db = getCloudDb(process.env.DATABASE_URL as string);
const suffix = randomUUID().slice(0, 8);
let ownerA: string;
let ownerB: string;

const callerFor = (id: string) =>
  keysRouter.createCaller({
    ...buildAuthedContext(),
    ...withCloudUser({ id, email: `${id}@example.com`, name: null }),
  });

beforeAll(async () => {
  installCloudDb(db);
  const [a] = await db
    .insert(users)
    .values({ email: `sc1353-a-${suffix}@example.com`, name: 'a' })
    .returning();
  const [b] = await db
    .insert(users)
    .values({ email: `sc1353-b-${suffix}@example.com`, name: 'b' })
    .returning();
  ownerA = a!.id;
  ownerB = b!.id;
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [ownerA, ownerB]));
  installCloudDb(null);
});

describe('keys.create is capped per owner (SC-1353)', () => {
  test('an owner may hold the cap and no more', async () => {
    const a = callerFor(ownerA);
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_OWNER; i++) await a.create({ name: `k${i}` });
    await expect(a.create({ name: 'one too many' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('key_limit'),
    });
  });

  test('another owner is unaffected (control)', async () => {
    await expect(callerFor(ownerB).create({ name: 'first' })).resolves.toMatchObject({
      name: 'first',
    });
  });

  test('a revoked key frees its slot', async () => {
    const [one] = await db
      .select({ id: cloudApiKeys.id })
      .from(cloudApiKeys)
      .where(eq(cloudApiKeys.ownerUserId, ownerA))
      .limit(1);
    await db
      .update(cloudApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(cloudApiKeys.id, one!.id));
    await expect(callerFor(ownerA).create({ name: 'after revoke' })).resolves.toMatchObject({
      name: 'after revoke',
    });
  });
});
