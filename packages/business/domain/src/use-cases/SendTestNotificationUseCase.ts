import { createComponentLogger } from '@scani/logging';
import { isVapidMismatch, PushSender } from '@scani/push';
import { Container, Service } from 'typedi';
import { PushSubscriptionRepository } from '../repositories/PushSubscriptionRepository';
import { REMINDER_TARGET_PATH } from './SendPaymentDueRemindersUseCase';

const logger = createComponentLogger('use-case:test-notification');

/**
 * What one endpoint answered.
 *
 * The vocabulary is the push sender's own — `gone` means exactly what it means
 * to the reminder job, and is pruned the same way — with one addition the
 * reminder does not need to distinguish: a 403.
 */
export type TestNotificationOutcome =
  | { status: 'sent' }
  /** 404/410: the subscription is dead, and the row has been deleted. */
  | { status: 'gone' }
  /** 403: this deployment's VAPID keypair is not the one that subscription
   *  was created under. Ours to fix, and nothing can be delivered until it
   *  is (see `isVapidMismatch`). */
  | { status: 'vapid-mismatch' }
  | { status: 'failed'; statusCode: number | null; reason: string };

export interface TestNotificationDevice {
  /**
   * The caller's own endpoint, returned so the client can tell the device in
   * the reader's hand from the one in the next room. It never reaches a log
   * line — see the `push_subscriptions` schema note — but returning it to the
   * user who registered it, over their own authenticated request, is the only
   * way the answer can say "this device".
   */
  endpoint: string;
  userAgent: string | null;
  outcome: TestNotificationOutcome;
}

export interface TestNotificationReport {
  /** False when this deployment has no VAPID keys, so nothing was attempted. */
  configured: boolean;
  devices: TestNotificationDevice[];
  /** Rows deleted because the push service said they were gone. */
  pruned: number;
}

/**
 * Repeated taps REPLACE each other on the lock screen rather than stacking.
 *
 * Constant rather than per-send: someone checking whether notifications work
 * presses the button again when nothing appears, and three identical
 * notifications arriving at once is its own reason to revoke the permission.
 * The reminder uses the same mechanism for the same reason.
 */
export const TEST_NOTIFICATION_TAG = 'push-test';

/**
 * Answer "did that actually reach my phone", without the VAPID private key
 * leaving the server (SC-322).
 *
 * Before this, the only ways to know were to wait for a real payment to fall
 * due or to hand-roll a `web-push` send from a laptop with the private key
 * read out of a password manager. Both are wrong: one puts a production secret
 * on a developer machine for a routine check, and the other leaves a user who
 * has just granted a permission with no evidence that anything works — which
 * is a permission that gets revoked.
 *
 * It reports per ENDPOINT rather than a boolean because the two failures worth
 * finding are per-endpoint and mean opposite things:
 *
 * - **410** — that subscription is dead. The row is pruned here, exactly as
 *   the reminder job prunes it, and the reader is told to re-enable on that
 *   device.
 * - **403** — the api and the sender are not holding the same VAPID keypair.
 *   Every subscription stored under the other key is undeliverable, and
 *   nothing else in the system says so: `subscribe` succeeds, `status` counts
 *   the device, and the reminder just quietly fails once a day.
 *
 * `{ ok: true }` can say neither, which is the whole reason this exists.
 */
@Service()
export class SendTestNotificationUseCase {
  private readonly subscriptions = Container.get(PushSubscriptionRepository);
  private readonly pushSender = Container.get(PushSender);

  async execute(userId: string): Promise<TestNotificationReport> {
    if (!this.pushSender.isConfigured()) {
      // A refusal, not an empty result: "this server cannot send" and "you
      // have no devices" are different sentences to the reader and different
      // work for whoever fixes them.
      return { configured: false, devices: [], pruned: 0 };
    }

    const devices = await this.subscriptions.findByUser(userId);
    if (devices.length === 0) return { configured: true, devices: [], pruned: 0 };

    const payload = {
      title: 'Scani',
      body: 'Notifications are working. This is the test you asked for — nothing is due.',
      // The reminder's own constant, never a copy of it. A path that has
      // drifted lands in the classic UI, and a test send that does that
      // teaches the reader their notifications are broken when they are not
      // (guarded by `apps/frontend/app/tests/lib/reminder-route.test.ts`).
      url: REMINDER_TARGET_PATH,
      tag: TEST_NOTIFICATION_TAG,
    };

    const results = await Promise.all(
      devices.map(async (device) => ({
        id: device.id,
        endpoint: device.endpoint,
        userAgent: device.userAgent,
        outcome: describeOutcome(
          await this.pushSender.send(
            { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
            payload
          )
        ),
      }))
    );

    // Deliberately no `markSent`. That column starts a 12-hour cooldown on the
    // real reminder, so recording a test inside it would silence the very
    // notification the user has just confirmed works.
    const goneIds = results.filter((r) => r.outcome.status === 'gone').map((r) => r.id);
    const pruned = await this.subscriptions.deleteByIds(goneIds);

    const mismatched = results.filter((r) => r.outcome.status === 'vapid-mismatch').length;
    if (mismatched > 0) {
      // An operator problem, and the only place in the system that can name
      // it: every other surface reports a healthy-looking subscription.
      logger.error(
        { userId, mismatched },
        '🔑 Push rejected with 403 — the VAPID keypair these subscriptions were created under is not the one this deployment signs with'
      );
    }

    logger.info(
      {
        userId,
        sent: results.filter((r) => r.outcome.status === 'sent').length,
        pruned,
        mismatched,
        failed: results.filter((r) => r.outcome.status === 'failed').length,
      },
      '🔔 Test notification'
    );

    return {
      configured: true,
      devices: results.map(({ endpoint, userAgent, outcome }) => ({
        endpoint,
        userAgent,
        outcome,
      })),
      pruned,
    };
  }
}

/**
 * A send result as the reader needs to hear it.
 *
 * The only translation is pulling 403 out of the generic failure: the sender
 * keeps it there on purpose, because the reminder job must count it as a
 * failure and must never prune on it.
 */
function describeOutcome(result: Awaited<ReturnType<PushSender['send']>>): TestNotificationOutcome {
  switch (result.status) {
    case 'sent':
      return { status: 'sent' };
    case 'gone':
      return { status: 'gone' };
    case 'not-configured':
      // The keys went away between the check above and the send. Vanishingly
      // rare, and still not something to report as a delivery.
      return {
        status: 'failed',
        statusCode: null,
        reason: `Push is not configured: missing ${result.missing.join(', ')}`,
      };
    case 'failed':
      if (isVapidMismatch(result.statusCode)) return { status: 'vapid-mismatch' };
      return {
        status: 'failed',
        statusCode: result.statusCode ?? null,
        reason: result.reason,
      };
  }
}
