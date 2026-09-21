import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PushSubscriptionRepository } from '../../src/repositories/PushSubscriptionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => Container.get(PushSubscriptionRepository);

const ENDPOINT = 'https://push.example.test/send/victim-device';
const VICTIM_KEYS = { p256dh: 'victim-p256dh', auth: 'victim-auth' };

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

const rowsFor = (tx: Tx) =>
  tx.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, ENDPOINT));

/**
 * The endpoint is the row's identity, and the conflict path used to rewrite
 * `user_id`, `p256dh` and `auth` whoever asked. Anyone who learned a victim's
 * endpoint URL could re-point it at their own keys, and the victim's device
 * would stop receiving notifications (SC-1288).
 *
 * The keys are what separate the two cases that look alike. A second person
 * signing in on a shared browser gets the SAME subscription back from the push
 * manager, keys included, so they can still take the endpoint over. Someone
 * who only knows the URL does not have its `auth` secret.
 */
describe('PushSubscriptionRepository.upsert — endpoint ownership (SC-1288)', () => {
  test("B cannot re-point A's endpoint at B's keys", async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      await repo().upsert({ userId: a.id, endpoint: ENDPOINT, ...VICTIM_KEYS }, tx);

      const result = await repo().upsert(
        { userId: b.id, endpoint: ENDPOINT, p256dh: 'attacker-p256dh', auth: 'attacker-auth' },
        tx
      );

      expect(result).toBeNull();
      const rows = await rowsFor(tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: a.id, ...VICTIM_KEYS });
    });
  });

  test('a shared browser, which presents the same keys, moves to whoever signed in', async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const first = await repo().upsert({ userId: a.id, endpoint: ENDPOINT, ...VICTIM_KEYS }, tx);

      const second = await repo().upsert({ userId: b.id, endpoint: ENDPOINT, ...VICTIM_KEYS }, tx);

      expect(second?.userId).toBe(b.id);
      // A new row rather than A's row re-owned: nothing of A's carries over.
      expect(second?.id).not.toBe(first?.id);
      expect(await rowsFor(tx)).toHaveLength(1);
    });
  });

  test('the owner can still refresh their own keys — the control', async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      await repo().upsert({ userId: a.id, endpoint: ENDPOINT, ...VICTIM_KEYS }, tx);

      const refreshed = await repo().upsert(
        { userId: a.id, endpoint: ENDPOINT, p256dh: 'rotated-p256dh', auth: 'rotated-auth' },
        tx
      );

      expect(refreshed).toMatchObject({
        userId: a.id,
        p256dh: 'rotated-p256dh',
        auth: 'rotated-auth',
      });
      expect(await rowsFor(tx)).toHaveLength(1);
    });
  });
});
