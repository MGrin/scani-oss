import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { SendTestNotificationUseCase } from '@scani/domain/use-cases';
import { PushSender } from '@scani/push';
import { eq } from 'drizzle-orm';
import Container from 'typedi';
import { USER_BUDGETS } from '../../../src/config/limits';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1346: `push.subscribe` stored any https endpoint and `push.test` POSTed to
// every stored one, returning each device's status and error text: a probe of
// hosts and ports the api can reach, Fly's private network included.

restoreContainerAfterAll();

const suffix = randomUUID().slice(0, 8);
const KEYS = { p256dh: 'p256dh-key', auth: 'auth-key' };
const fcm = (id: string) => `https://fcm.googleapis.com/fcm/send/sc1346-${suffix}-${id}`;

let user: typeof schema.users.$inferSelect;
const sent: string[] = [];

class StubPushSender extends PushSender {
  override isConfigured(): boolean {
    return true;
  }
  override async send(target: { endpoint: string }) {
    sent.push(target.endpoint);
    return {
      status: 'failed' as const,
      statusCode: 500,
      reason: 'connect ECONNREFUSED 10.0.0.5:6379',
    };
  }
}

async function endpointsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ endpoint: schema.pushSubscriptions.endpoint })
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId));
  return rows.map((r) => r.endpoint);
}

beforeAll(async () => {
  Container.set(PushSender, new StubPushSender());
  Container.set(SendTestNotificationUseCase, new SendTestNotificationUseCase());
  const [row] = await db
    .insert(schema.users)
    .values({ email: `sc1346-${suffix}@scani.local`, name: 'sc1346' })
    .returning();
  user = row!;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
});

describe('push.subscribe only stores real push services (SC-1346)', () => {
  test('an internal host is refused and not stored', async () => {
    const endpoint = 'https://scani-worker.internal:6379/';
    const result = await makeAuthedCaller(user).push.subscribe({
      subscription: { endpoint, keys: KEYS },
    });
    expect(result).toEqual({ stored: false, reason: 'endpoint-not-allowed' });
    expect(await endpointsOf(user.id)).not.toContain(endpoint);
  });

  test('control: a browser push endpoint is stored', async () => {
    const result = await makeAuthedCaller(user).push.subscribe({
      subscription: { endpoint: fcm('control'), keys: KEYS },
    });
    expect(result).toEqual({ stored: true });
    expect(await endpointsOf(user.id)).toContain(fcm('control'));
  });

  test('a user keeps at most 10 devices, and the newest one is always kept', async () => {
    for (let i = 0; i < 12; i += 1) {
      await makeAuthedCaller(user).push.subscribe({
        subscription: { endpoint: fcm(`cap-${i}`), keys: KEYS },
      });
    }
    const endpoints = await endpointsOf(user.id);
    expect(endpoints).toHaveLength(10);
    expect(endpoints).toContain(fcm('cap-11'));
  });
});

describe('push.test (SC-1346)', () => {
  test('reports no upstream error text', async () => {
    const report = await makeAuthedCaller(user).push.test();
    expect(report.devices.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
    expect(report.devices[0]?.outcome).toEqual({ status: 'failed', statusCode: 500 });
  });

  test('is rate-limited per user', async () => {
    let refused: unknown = null;
    for (let i = 0; i < USER_BUDGETS.PUSH_TESTS_PER_HOUR + 1 && !refused; i += 1) {
      try {
        await makeAuthedCaller(user).push.test();
      } catch (error) {
        refused = error;
      }
    }
    expect(String(refused)).toContain('Too many');
  });
});
