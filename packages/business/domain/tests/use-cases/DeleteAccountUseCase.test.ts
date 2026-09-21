/**
 * Runs the real flow against a real database (SC-1260).
 *
 * Seeds are COMMITTED, for the reason `DeleteAllUserDataUseCase.test.ts` gives:
 * the use case opens its own transaction on the module-level connection, so a
 * rolled-back outer transaction would be invisible to it. Every case seeds a
 * CONTROL user with the same rows and asserts they survive, because a flow that
 * emptied every table would satisfy the target's assertions on its own.
 */

import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray, or } from 'drizzle-orm';
import { Container } from 'typedi';
import { DeleteAccountUseCase } from '../../src/use-cases/DeleteAccountUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeToken } from '../../test/helpers/factories-extra';

restoreContainerAfterAll();

const createdUsers: string[] = [];
const createdTokens: string[] = [];
const createdInstitutions: string[] = [];

interface Seeded {
  userId: string;
  email: string;
}

/** A user with the rows an account holds: data, a login, a session and pending sign-in links. */
async function seedAccount(email: string): Promise<Seeded> {
  return getDb().transaction(async (tx) => {
    const user = await makeUser(tx, { email });
    createdUsers.push(user.id);
    const institution = await makeInstitution(tx);
    createdInstitutions.push(institution.id);
    await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    await tx.insert(schema.userSessions).values({
      id: randomUUID(),
      token: randomUUID(),
      userId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await tx.insert(schema.userAccounts).values({
      id: randomUUID(),
      accountId: user.id,
      providerId: 'credential',
      userId: user.id,
    });
    // The two shapes Better Auth writes: email-OTP keys the row on the address,
    // magic-link keys it on a token and carries the address in the value.
    await tx.insert(schema.userVerifications).values([
      {
        id: randomUUID(),
        identifier: `sign-in-otp-${email}`,
        value: 'hashed:0',
        expiresAt: new Date(Date.now() + 300_000),
      },
      {
        id: randomUUID(),
        identifier: randomUUID(),
        value: JSON.stringify({ email, name: '' }),
        expiresAt: new Date(Date.now() + 300_000),
      },
    ]);
    return { userId: user.id, email };
  });
}

async function counts({ userId, email }: Seeded) {
  const db = getDb();
  const [users, sessions, logins, accounts, verifications] = await Promise.all([
    db.select().from(schema.users).where(eq(schema.users.id, userId)),
    db.select().from(schema.userSessions).where(eq(schema.userSessions.userId, userId)),
    db.select().from(schema.userAccounts).where(eq(schema.userAccounts.userId, userId)),
    db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    db
      .select()
      .from(schema.userVerifications)
      .where(
        or(
          eq(schema.userVerifications.identifier, `sign-in-otp-${email}`),
          eq(schema.userVerifications.value, JSON.stringify({ email, name: '' }))
        )
      ),
  ]);
  return {
    users: users.length,
    sessions: sessions.length,
    logins: logins.length,
    accounts: accounts.length,
    verifications: verifications.length,
  };
}

const EVERYTHING = { users: 1, sessions: 1, logins: 1, accounts: 1, verifications: 2 };
const NOTHING = { users: 0, sessions: 0, logins: 0, accounts: 0, verifications: 0 };

afterAll(async () => {
  const db = getDb();
  await db
    .delete(schema.tokenPriceEditHistory)
    .where(inArray(schema.tokenPriceEditHistory.editedByUserId, createdUsers));
  for (const userId of createdUsers) {
    await Container.get(DeleteAccountUseCase).execute(userId);
  }
  if (createdTokens.length > 0) {
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, createdTokens));
  }
  if (createdInstitutions.length > 0) {
    await db
      .delete(schema.institutions)
      .where(inArray(schema.institutions.id, createdInstitutions));
  }
});

test('removes the account and its login, and leaves another account alone', async () => {
  // An underscore is a LIKE wildcard: a match built on LIKE would reach
  // `aXb@…` from `a_b@…`, so the control's address differs only there.
  const tag = randomUUID().slice(0, 8);
  const target = await seedAccount(`a_b-${tag}@example.invalid`);
  const control = await seedAccount(`aXb-${tag}@example.invalid`);
  expect(await counts(target)).toEqual(EVERYTHING);

  expect(await Container.get(DeleteAccountUseCase).execute(target.userId)).toEqual({
    deleted: true,
  });

  expect(await counts(target)).toEqual(NOTHING);
  expect(await counts(control)).toEqual(EVERYTHING);
});

test('an id with no user reads as not deleted, so a re-run is harmless', async () => {
  expect(await Container.get(DeleteAccountUseCase).execute(randomUUID())).toEqual({
    deleted: false,
  });
});

test('refuses an account that edited a global price, and deletes nothing', async () => {
  const target = await seedAccount(`editor-${randomUUID().slice(0, 8)}@example.invalid`);
  await getDb().transaction(async (tx) => {
    const token = await makeToken(tx);
    const base = await makeToken(tx);
    createdTokens.push(token.id, base.id);
    await tx.insert(schema.tokenPriceEditHistory).values({
      tokenId: token.id,
      baseTokenId: base.id,
      newPrice: '1',
      editedByUserId: target.userId,
    });
  });

  await expect(Container.get(DeleteAccountUseCase).execute(target.userId)).rejects.toThrow(
    /edited a global token price/
  );
  expect(await counts(target)).toEqual(EVERYTHING);
});
