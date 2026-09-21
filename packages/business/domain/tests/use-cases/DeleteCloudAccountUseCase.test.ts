/**
 * Runs the real flow against a real database (SC-1263).
 *
 * Seeds are COMMITTED because the use case opens its own transaction on the
 * module-level connection, so a rolled-back outer transaction would be
 * invisible to it. Every case seeds a CONTROL cloud user with the same rows
 * and asserts they survive, because a flow that emptied every cloud table
 * would satisfy the target's assertions on its own.
 */

import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray, or } from 'drizzle-orm';
import { Container } from 'typedi';
import { DeleteCloudAccountUseCase } from '../../src/use-cases/DeleteCloudAccountUseCase';

const createdUsers: string[] = [];

interface Seeded {
  userId: string;
  email: string;
}

async function seedCloudAccount(email: string): Promise<Seeded> {
  return getDb().transaction(async (tx) => {
    const [user] = await tx.insert(schema.cloudUsers).values({ email }).returning();
    if (!user) throw new Error('cloud_users insert failed');
    createdUsers.push(user.id);
    await tx.insert(schema.cloudSessions).values({
      userId: user.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await tx
      .insert(schema.cloudAccounts)
      .values({ userId: user.id, providerId: 'credential', accountId: user.id });
    await tx.insert(schema.cloudApiKeys).values({
      ownerUserId: user.id,
      tenantId: user.id,
      name: 'fixture',
      keyPrefix: 'scani_sk_test',
      hashedKey: randomUUID(),
    });
    await tx.insert(schema.cloudVerifications).values([
      {
        identifier: `sign-in-otp-${email}`,
        value: 'hashed:0',
        expiresAt: new Date(Date.now() + 300_000),
      },
      {
        identifier: randomUUID(),
        value: JSON.stringify({ email, name: '' }),
        expiresAt: new Date(Date.now() + 300_000),
      },
    ]);
    await tx.insert(schema.cloudUsageEvents).values({
      subject: user.id,
      route: 'fixture',
      provider: 'fixture',
      outcome: 'ok',
      durationMs: 1,
    });
    return { userId: user.id, email };
  });
}

async function counts({ userId, email }: Seeded) {
  const db = getDb();
  const [users, sessions, logins, keys, verifications, usage] = await Promise.all([
    db.select().from(schema.cloudUsers).where(eq(schema.cloudUsers.id, userId)),
    db.select().from(schema.cloudSessions).where(eq(schema.cloudSessions.userId, userId)),
    db.select().from(schema.cloudAccounts).where(eq(schema.cloudAccounts.userId, userId)),
    db.select().from(schema.cloudApiKeys).where(eq(schema.cloudApiKeys.ownerUserId, userId)),
    db
      .select()
      .from(schema.cloudVerifications)
      .where(
        or(
          eq(schema.cloudVerifications.identifier, `sign-in-otp-${email}`),
          eq(schema.cloudVerifications.value, JSON.stringify({ email, name: '' }))
        )
      ),
    db.select().from(schema.cloudUsageEvents).where(eq(schema.cloudUsageEvents.subject, userId)),
  ]);
  return {
    users: users.length,
    sessions: sessions.length,
    logins: logins.length,
    keys: keys.length,
    verifications: verifications.length,
    usage: usage.length,
  };
}

const EVERYTHING = { users: 1, sessions: 1, logins: 1, keys: 1, verifications: 2, usage: 1 };

afterAll(async () => {
  const db = getDb();
  if (createdUsers.length === 0) return;
  await db
    .delete(schema.cloudUsageEvents)
    .where(inArray(schema.cloudUsageEvents.subject, createdUsers));
  await db.delete(schema.cloudUsers).where(inArray(schema.cloudUsers.id, createdUsers));
});

test('removes the cloud account, its keys and logins, keeps its usage log, and leaves another alone', async () => {
  // An underscore is a LIKE wildcard: a match built on LIKE would reach
  // `aXb@…` from `a_b@…`, so the control's address differs only there.
  const tag = randomUUID().slice(0, 8);
  const target = await seedCloudAccount(`a_b-${tag}@example.invalid`);
  const control = await seedCloudAccount(`aXb-${tag}@example.invalid`);
  expect(await counts(target)).toEqual(EVERYTHING);

  expect(await Container.get(DeleteCloudAccountUseCase).execute(target.userId)).toEqual({
    deleted: true,
  });

  // The usage log is what SC-1262's forensics read and what billing counts;
  // it names the account by id in a text column, so it outlives the account.
  expect(await counts(target)).toEqual({
    users: 0,
    sessions: 0,
    logins: 0,
    keys: 0,
    verifications: 0,
    usage: 1,
  });
  expect(await counts(control)).toEqual(EVERYTHING);
});

test('an id with no cloud user reads as not deleted, so a re-run is harmless', async () => {
  expect(await Container.get(DeleteCloudAccountUseCase).execute(randomUUID())).toEqual({
    deleted: false,
  });
});
