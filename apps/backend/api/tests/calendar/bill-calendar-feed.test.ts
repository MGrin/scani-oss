import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  BILL_CALENDAR_TOKEN_PREFIX,
  BillCalendarFeedService,
} from '../../src/calendar/bill-calendar-feed';

// SC-1654: the opt-in, revocable URL a calendar app subscribes to.

type User = typeof schema.users.$inferSelect;
const service = new BillCalendarFeedService();
const created: string[] = [];

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1654-cal-${name}-${randomUUID().slice(0, 8)}@scani.local`, name })
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

describe('BillCalendarFeedService', () => {
  test('off by default', async () => {
    expect(await service.status(bob.id)).toEqual({ enabled: false, createdAt: null });
  });

  test('turning it on returns a 256-bit token once, stores only its hash, and the token resolves', async () => {
    const token = await service.enable(alice.id);
    expect(token.startsWith(BILL_CALENDAR_TOKEN_PREFIX)).toBe(true);
    const secret = token.slice(BILL_CALENDAR_TOKEN_PREFIX.length);
    expect(Buffer.from(secret, 'base64url').length).toBe(32);

    const [row] = await db
      .select()
      .from(schema.billCalendarFeeds)
      .where(eq(schema.billCalendarFeeds.userId, alice.id));
    expect(row?.hashedToken).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(secret);

    expect(await service.resolve(token)).toBe(alice.id);
    expect((await service.status(alice.id)).enabled).toBe(true);
  });

  test('rotating kills the old URL at once and the new one works', async () => {
    const old = await service.enable(alice.id);
    const fresh = await service.rotate(alice.id);
    if (!fresh) throw new Error('rotate returned no token for a feed that is on');
    expect(fresh).not.toBe(old);
    expect(await service.resolve(old)).toBeNull();
    expect(await service.resolve(fresh)).toBe(alice.id);
  });

  test('turning it off kills the URL at once', async () => {
    const token = await service.enable(alice.id);
    await service.disable(alice.id);
    expect(await service.resolve(token)).toBeNull();
    expect(await service.status(alice.id)).toEqual({ enabled: false, createdAt: null });
  });

  test('turning it on again replaces the previous URL', async () => {
    const first = await service.enable(alice.id);
    const second = await service.enable(alice.id);
    expect(await service.resolve(first)).toBeNull();
    expect(await service.resolve(second)).toBe(alice.id);
  });

  test('an unknown or malformed token resolves to nobody', async () => {
    expect(await service.resolve(`${BILL_CALENDAR_TOKEN_PREFIX}${'A'.repeat(43)}`)).toBeNull();
    expect(await service.resolve('not-a-token')).toBeNull();
    expect(await service.resolve('')).toBeNull();
  });

  test('rotating a feed that is off does not turn it on', async () => {
    expect(await service.rotate(bob.id)).toBeNull();
    expect((await service.status(bob.id)).enabled).toBe(false);
  });
});
