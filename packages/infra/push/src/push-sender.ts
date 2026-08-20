import { createComponentLogger } from '@scani/logging';
import { Service } from 'typedi';
import webpush from 'web-push';
import { resolveVapid } from './config';

const logger = createComponentLogger('push:sender');

/** One browser on one device, exactly as `PushSubscription.toJSON()` gives it. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * What the service worker's `push` handler reads (`apps/frontend/app/public/sw.js`).
 *
 * `tag` is not cosmetic: it makes a re-send REPLACE the notification on the
 * lock screen rather than stack beside it. The reminder job's advisory lock
 * already prevents a double send, but a lock cannot help once two
 * notifications have been delivered — and being told twice that money is due
 * tomorrow is worse than being told once (SC-226).
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export type PushSendResult =
  /** Accepted by the push service. Not a guarantee the device displayed it. */
  | { status: 'sent' }
  /**
   * The subscription no longer exists — the user cleared site data, removed
   * the PWA, or the browser rotated the endpoint. The row should be deleted:
   * keeping it costs one rejected request per fire, forever.
   */
  | { status: 'gone' }
  | { status: 'failed'; statusCode?: number; reason: string }
  /** Nothing was attempted because this deployment has no VAPID keys. */
  | { status: 'not-configured'; missing: string[] };

/**
 * Map a push service's status code onto "is this subscription dead".
 *
 * Pure and exported because it is the whole risk surface of the send: get it
 * wrong in the permissive direction and a transient failure deletes a live
 * subscription, which unsubscribes a user who never asked to be
 * unsubscribed and gives them no signal that it happened.
 *
 * **403 is NOT gone.** RFC 8292 uses it for a VAPID mismatch — our own key
 * rotated, or the subscription was created under a different application
 * server. The subscription is fine; we are the ones who changed. Treating it
 * as gone would delete every subscription in the table on the first deploy
 * that regenerated the keypair.
 */
export function isSubscriptionGone(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

/**
 * The other half of that decision: 403 is the push service refusing OUR
 * credentials, not the device's.
 *
 * RFC 8292 §4 — the VAPID signature does not match the application-server key
 * the subscription was created with. It is the only failure that says nothing
 * about the user: the endpoint is live, the phone is fine, and every send to
 * it will fail identically until the key the api hands to
 * `pushManager.subscribe()` and the key this sender signs with are the same
 * pair again.
 *
 * Named rather than left as "a failure with statusCode 403" because it is the
 * one outcome a user can neither cause nor fix, and the one that makes a
 * subscription look healthy while nothing can ever be delivered to it — the
 * exact shape a test send exists to surface (SC-322).
 */
export function isVapidMismatch(statusCode: number | undefined): boolean {
  return statusCode === 403;
}

@Service()
export class PushSender {
  isConfigured(): boolean {
    return resolveVapid().ok;
  }

  /**
   * The application-server public key the browser needs to subscribe, or null
   * when this deployment cannot send at all.
   *
   * Null rather than an empty string on purpose: the caller has to decide
   * between "subscribe" and "tell the user this server cannot notify them",
   * and an empty string is the shape that gets passed to
   * `pushManager.subscribe()` and fails inside the browser instead.
   */
  publicKey(): string | null {
    const vapid = resolveVapid();
    return vapid.ok ? vapid.details.publicKey : null;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushSendResult> {
    const vapid = resolveVapid();
    if (!vapid.ok) {
      // Warn rather than throw: a reminder job with no keys should report the
      // refusal on every fire and keep running, not crash into the DLQ hourly.
      logger.warn(
        { missing: vapid.missing },
        '🔕 Web Push is not configured; no notification was sent'
      );
      return { status: 'not-configured', missing: vapid.missing };
    }

    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: vapid.details,
          // Long enough to survive a phone that is asleep at 17:00, short
          // enough that a reminder about tomorrow can never arrive after
          // tomorrow has started.
          TTL: 6 * 60 * 60,
        }
      );
      return { status: 'sent' };
    } catch (error) {
      const statusCode =
        error instanceof webpush.WebPushError
          ? error.statusCode
          : (undefined as number | undefined);
      if (isSubscriptionGone(statusCode)) return { status: 'gone' };
      const reason = error instanceof Error ? error.message : String(error);
      // The endpoint is a per-device identifier — see the note on the
      // `push_subscriptions` schema — so it never reaches a log line.
      logger.warn({ statusCode, reason }, 'Push send failed');
      return { status: 'failed', statusCode, reason };
    }
  }
}
