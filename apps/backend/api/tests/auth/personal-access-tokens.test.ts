import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  MAX_LIVE_TOKENS_PER_USER,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  PersonalAccessTokenLimitError,
  PersonalAccessTokenService,
} from '../../src/auth/personal-access-tokens';

// SC-1614: a user's own bearer token for their AI agent.

type User = typeof schema.users.$inferSelect;
const service = new PersonalAccessTokenService();
const created: string[] = [];

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1614-pat-${name}-${randomUUID().slice(0, 8)}@scani.local`, name })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  created.push(user.id);
  return user;
}

let alice: User;
let bob: User;

beforeAll(async () => {
  alice = await makeUser('alice');
  bob = await makeUser('bob');
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, created));
});

describe('PersonalAccessTokenService', () => {
  test('stores only the hash, and the raw token verifies back to its owner', async () => {
    const minted = await service.create(alice.id, 'Claude Code');
    expect(minted.token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(minted.token.length).toBeGreaterThanOrEqual(PERSONAL_ACCESS_TOKEN_PREFIX.length + 40);
    expect(minted.tokenPrefix).toBe(minted.token.slice(0, minted.tokenPrefix.length));

    const [row] = await db
      .select()
      .from(schema.personalAccessTokens)
      .where(eq(schema.personalAccessTokens.id, minted.id));
    expect(row?.hashedToken).toBe(createHash('sha256').update(minted.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(minted.token);
    expect(row?.scopes).toEqual(['portfolio:read']);

    const verified = await service.verify(minted.token);
    expect(verified).toEqual({ tokenId: minted.id, userId: alice.id, scopes: ['portfolio:read'] });
  });

  test('an unknown, malformed or revoked token does not verify', async () => {
    expect(await service.verify(`${PERSONAL_ACCESS_TOKEN_PREFIX}${'0'.repeat(48)}`)).toBeNull();
    expect(await service.verify('not-a-scani-token')).toBeNull();
    expect(await service.verify('')).toBeNull();

    const minted = await service.create(alice.id, 'to revoke');
    expect(await service.verify(minted.token)).not.toBeNull();
    expect(await service.revoke(alice.id, minted.id)).toBe(true);
    expect(await service.verify(minted.token)).toBeNull();
  });

  test('list shows the caller’s live tokens only, without the secret', async () => {
    const mine = await service.create(bob.id, 'bob one');
    const revoked = await service.create(bob.id, 'bob gone');
    await service.revoke(bob.id, revoked.id);

    const listed = await service.list(bob.id);
    expect(listed.map((t) => t.id)).toEqual([mine.id]);
    expect(listed[0]).toMatchObject({ name: 'bob one', tokenPrefix: mine.tokenPrefix });
    expect(JSON.stringify(listed)).not.toContain(mine.token);
    expect(JSON.stringify(listed)).not.toContain('hashed');

    const alices = await service.list(alice.id);
    expect(alices.map((t) => t.id)).not.toContain(mine.id);
  });

  test('a user cannot revoke another user’s token', async () => {
    const bobs = await service.create(bob.id, 'bob keeps');
    expect(await service.revoke(alice.id, bobs.id)).toBe(false);
    expect(await service.verify(bobs.token)).not.toBeNull();
  });

  test('verify stamps last use', async () => {
    const minted = await service.create(alice.id, 'stamped');
    await service.verify(minted.token);
    const [row] = await db
      .select({ lastUsedAt: schema.personalAccessTokens.lastUsedAt })
      .from(schema.personalAccessTokens)
      .where(eq(schema.personalAccessTokens.id, minted.id));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  test('refuses a new token past the per-user cap, and revoking frees a slot', async () => {
    const carol = await makeUser('carol');
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_TOKENS_PER_USER; i++) {
      ids.push((await service.create(carol.id, `t${i}`)).id);
    }
    await expect(service.create(carol.id, 'one too many')).rejects.toBeInstanceOf(
      PersonalAccessTokenLimitError
    );
    await service.revoke(carol.id, ids[0] as string);
    const again = await service.create(carol.id, 'fits now');
    expect(again.id).toBeString();
  });
});
