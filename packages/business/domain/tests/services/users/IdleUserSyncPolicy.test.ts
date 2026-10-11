/**
 * Seeds are committed: the policy reads through the module-level connection,
 * so rows inside a rolled-back transaction would be invisible to it.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { inArray } from 'drizzle-orm';
import { IdleUserSyncPolicy } from '../../../src/services/users/IdleUserSyncPolicy';
import { makeUser } from '../../../test/helpers/factories';

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-07T13:00:00Z');
const created: string[] = [];

async function user(createdDaysAgo: number, sessionDaysAgo: number | null): Promise<string> {
  return getDb().transaction(async (tx) => {
    const row = await makeUser(tx, { createdAt: new Date(NOW.getTime() - createdDaysAgo * DAY) });
    created.push(row.id);
    if (sessionDaysAgo !== null) {
      await tx.insert(schema.userSessions).values({
        id: randomUUID(),
        token: randomUUID(),
        userId: row.id,
        expiresAt: new Date(NOW.getTime() + DAY),
        updatedAt: new Date(NOW.getTime() - sessionDaysAgo * DAY),
      });
    }
    return row.id;
  });
}

afterAll(async () => {
  await getDb().delete(schema.users).where(inArray(schema.users.id, created));
});

describe('IdleUserSyncPolicy (SC-1602)', () => {
  test('skips an old account with no recent session, and nobody else', async () => {
    const idle = await user(30, 8);
    const neverSignedIn = await user(30, null);
    const active = await user(30, 2);
    const fresh = await user(3, null);

    const skipped = await new IdleUserSyncPolicy().usersToSkip(NOW);

    expect(skipped.has(idle)).toBe(true);
    expect(skipped.has(neverSignedIn)).toBe(true);
    expect(skipped.has(active)).toBe(false);
    expect(skipped.has(fresh)).toBe(false);
  });

  test('every sixth hour skips no one, so idle users still sync four times a day', async () => {
    const idle = await user(30, 8);

    for (const hour of [0, 6, 12, 18]) {
      const at = new Date(Date.UTC(2026, 9, 7, hour, 2));
      expect((await new IdleUserSyncPolicy().usersToSkip(at)).size).toBe(0);
    }
    expect((await new IdleUserSyncPolicy().usersToSkip(NOW)).has(idle)).toBe(true);
  });
});
