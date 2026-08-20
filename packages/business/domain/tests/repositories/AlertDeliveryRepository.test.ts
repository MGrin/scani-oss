import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import {
  ALERT_CLAIM_TTL_MS,
  AlertDeliveryRepository,
} from '../../src/repositories/AlertDeliveryRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => Container.get(AlertDeliveryRepository);

const RULE = 'integration-stale';
const NOW = new Date('2026-08-19T09:00:00.000Z');

// Everything in this file is about ONE property: an alert is delivered at most
// once. It is the property that decides whether a user keeps the sender or
// filters it, and it is not enforced by the job's advisory lock (which covers
// overlapping fires, not retries) or by any per-account cooldown (which cannot
// express "not about this integration again").
describe('AlertDeliveryRepository (SC-459)', () => {
  test('a first claim is granted and a second is refused', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const candidates = [{ userId: user.id, dedupeKey: 'cred-1' }];

      const first = await repo().claim(RULE, candidates, NOW, tx);
      expect(first).toHaveLength(1);
      await repo().markSent(
        first.map((c) => c.id),
        NOW,
        tx
      );

      const second = await repo().claim(RULE, candidates, NOW, tx);
      expect(second).toEqual([]);
    });
  });

  test('a delivered alert is still refused long after the claim window', async () => {
    // The TTL retakes ABANDONED claims. A row that was actually sent must
    // suppress forever, or every alert repeats once an hour.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const candidates = [{ userId: user.id, dedupeKey: 'cred-1' }];
      const claimed = await repo().claim(RULE, candidates, NOW, tx);
      await repo().markSent(
        claimed.map((c) => c.id),
        NOW,
        tx
      );

      const muchLater = new Date(NOW.getTime() + 30 * ALERT_CLAIM_TTL_MS);
      expect(await repo().claim(RULE, candidates, muchLater, tx)).toEqual([]);
    });
  });

  test('a claim abandoned by a crash is retaken, but only after the TTL', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const candidates = [{ userId: user.id, dedupeKey: 'cred-1' }];
      await repo().claim(RULE, candidates, NOW, tx);

      // Inside the window a retry must NOT retake it: the first attempt may
      // still be in flight, and two in-flight sends is the duplicate.
      const inside = new Date(NOW.getTime() + ALERT_CLAIM_TTL_MS - 1000);
      expect(await repo().claim(RULE, candidates, inside, tx)).toEqual([]);

      const outside = new Date(NOW.getTime() + ALERT_CLAIM_TTL_MS + 1000);
      expect(await repo().claim(RULE, candidates, outside, tx)).toHaveLength(1);
    });
  });

  test('release hands a failed send back for the next fire', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const candidates = [{ userId: user.id, dedupeKey: 'cred-1' }];
      const claimed = await repo().claim(RULE, candidates, NOW, tx);

      await repo().release(
        claimed.map((c) => c.id),
        tx
      );

      // Immediately, not TTL later — a transport blip should not cost a day.
      expect(await repo().claim(RULE, candidates, NOW, tx)).toHaveLength(1);
    });
  });

  test('release never deletes a row that was already delivered', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const claimed = await repo().claim(RULE, [{ userId: user.id, dedupeKey: 'cred-1' }], NOW, tx);
      const ids = claimed.map((c) => c.id);
      await repo().markSent(ids, NOW, tx);

      await repo().release(ids, tx);

      expect(await repo().claim(RULE, [{ userId: user.id, dedupeKey: 'cred-1' }], NOW, tx)).toEqual(
        []
      );
    });
  });

  test('resolve clears an alert whose condition cleared, so a repeat fault alerts again', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const candidates = [{ userId: user.id, dedupeKey: 'cred-1' }];
      const claimed = await repo().claim(RULE, candidates, NOW, tx);
      await repo().markSent(
        claimed.map((c) => c.id),
        NOW,
        tx
      );

      expect(await repo().resolve(RULE, [], tx)).toBe(1);
      expect(await repo().claim(RULE, candidates, NOW, tx)).toHaveLength(1);
    });
  });

  test('resolve keeps rows that are still active and drops only the rest', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const still = { userId: user.id, dedupeKey: 'cred-still-broken' };
      const fixed = { userId: user.id, dedupeKey: 'cred-fixed' };
      const claimed = await repo().claim(RULE, [still, fixed], NOW, tx);
      await repo().markSent(
        claimed.map((c) => c.id),
        NOW,
        tx
      );

      expect(await repo().resolve(RULE, [still], tx)).toBe(1);

      expect(await repo().claim(RULE, [still], NOW, tx)).toEqual([]);
      expect(await repo().claim(RULE, [fixed], NOW, tx)).toHaveLength(1);
    });
  });

  test('resolve never touches another rule', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const claimed = await repo().claim(
        'other-rule',
        [{ userId: user.id, dedupeKey: 'k' }],
        NOW,
        tx
      );
      await repo().markSent(
        claimed.map((c) => c.id),
        NOW,
        tx
      );

      expect(await repo().resolve(RULE, [], tx)).toBe(0);
      expect(
        await repo().claim('other-rule', [{ userId: user.id, dedupeKey: 'k' }], NOW, tx)
      ).toEqual([]);
    });
  });

  test('two accounts with the same dedupe key are two independent alerts', async () => {
    // The key is scoped per user. A credential id happens to be unique, but the
    // next rule's key will be a date or a symbol, which is not.
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const claimed = await repo().claim(
        RULE,
        [
          { userId: a.id, dedupeKey: 'same' },
          { userId: b.id, dedupeKey: 'same' },
        ],
        NOW,
        tx
      );
      expect(claimed).toHaveLength(2);
    });
  });

  test('an empty batch never reaches the database', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().claim(RULE, [], NOW, tx)).toEqual([]);
      await repo().markSent([], NOW, tx);
      await repo().release([], tx);
    });
  });
});
