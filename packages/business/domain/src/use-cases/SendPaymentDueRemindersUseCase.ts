import { createComponentLogger } from '@scani/logging';
import { PushSender } from '@scani/push';
import { Container, Service } from 'typedi';
import { PaymentOccurrenceRepository } from '../repositories/PaymentOccurrenceRepository';
import { PushSubscriptionRepository } from '../repositories/PushSubscriptionRepository';
import {
  localTomorrow,
  reminderBody,
  shouldRemindNow,
  summariseForTomorrow,
} from '../services/payments/PaymentReminderService';

const logger = createComponentLogger('use-case:payment-due-reminders');

/**
 * Where a reminder lands when it is tapped: the Money screen (`V3_ROUTES.money`).
 *
 * A literal rather than an import, because this runs on the worker and the
 * route table is frontend code. It is checked against the real one by
 * `apps/frontend/app/tests/lib/reminder-route.test.ts` — a path that has
 * silently drifted takes the reader to the v2 fallback, from inside an
 * installed PWA that has no URL bar to leave it by.
 */
export const REMINDER_TARGET_PATH = '/payments';

/**
 * A device is not sent to twice inside this window.
 *
 * The processor's advisory lock stops two OVERLAPPING fires, which is a
 * different thing from stopping a second delivery: a job that sent to half the
 * users and then threw is retried by BullMQ, takes the lock cleanly because
 * the first attempt has ended, and pushes again to everyone it already
 * reached. `last_sent_at` is what closes that, and it also covers the one case
 * no lock can — a zone falling back over DST, where local 17:00 genuinely
 * happens twice in one day.
 *
 * Twelve hours: comfortably longer than any retry chain, comfortably shorter
 * than the 24 between two legitimate reminders.
 */
export const REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Users are processed in batches; each is independent. */
const USER_CONCURRENCY = 20;

export interface PaymentDueReminderSummary {
  /** Users with at least one push endpoint. Nobody else can be reminded. */
  candidates: number;
  /**
   * Subscribed users whose timezone is still NULL, so this job cannot place
   * them on a clock and skips them.
   *
   * Reported on every fire rather than inferred from a gap, because it is the
   * one number that separates "nothing was due" from "the feature is a no-op":
   * nothing writes `users.timezone` except the app itself, so if capture
   * regresses this climbs to the whole userbase while every other counter
   * stays a legitimate-looking zero.
   */
  missingTimezone: number;
  /** Users for whom it is currently the reminder hour, locally. */
  dueNow: number;
  /** Users at the reminder hour who had nothing due — deliberately silent. */
  silent: number;
  /** Users who were sent at least one notification. */
  notified: number;
  /** Endpoints the push service accepted. */
  sent: number;
  /** Endpoints deleted because the push service said they were gone. */
  pruned: number;
  /** Endpoints that failed for some other reason and were kept. */
  failed: number;
  /** Endpoints skipped because they were already sent to inside the cooldown. */
  suppressed: number;
  /** True when this deployment has no VAPID keys, so nothing was attempted. */
  unconfigured: boolean;
}

function emptySummary(): PaymentDueReminderSummary {
  return {
    candidates: 0,
    missingTimezone: 0,
    dueNow: 0,
    silent: 0,
    notified: 0,
    sent: 0,
    pruned: 0,
    failed: 0,
    suppressed: 0,
    unconfigured: false,
  };
}

/**
 * One push a day, at ~17:00 in each user's OWN local time, summarising the
 * payments due on their local tomorrow (SC-226).
 *
 * The job fires hourly and SELECTS. A single daily fire happens at one UTC
 * hour, and one UTC hour is a different clock time in every zone — so the
 * alternative to selecting is picking a zone and being wrong for everyone
 * else. Each user therefore matches exactly one of their own 24 fires, and the
 * other 23 cost one comparison.
 */
@Service()
export class SendPaymentDueRemindersUseCase {
  private readonly subscriptions = Container.get(PushSubscriptionRepository);
  private readonly occurrences = Container.get(PaymentOccurrenceRepository);
  private readonly pushSender = Container.get(PushSender);

  async execute(now: Date = new Date()): Promise<PaymentDueReminderSummary> {
    const summary = emptySummary();

    if (!this.pushSender.isConfigured()) {
      // A refusal, not an empty result. Without this line an operator reading
      // "0 notified" cannot tell a deployment with no VAPID keys from a
      // userbase with no bills due (the class in
      // `docs/technical/2026-08-15_absence-and-refusal.md`).
      logger.warn(
        '🔕 payment-due-reminder: VAPID keys are not configured; no reminders can be sent'
      );
      summary.unconfigured = true;
      return summary;
    }

    const candidates = await this.subscriptions.findReminderCandidates();
    summary.candidates = candidates.length;
    summary.missingTimezone = candidates.filter((c) => !c.timezone).length;

    const due = candidates.filter((candidate) => shouldRemindNow(now, candidate));
    summary.dueNow = due.length;

    for (let i = 0; i < due.length; i += USER_CONCURRENCY) {
      const batch = due.slice(i, i + USER_CONCURRENCY);
      const results = await Promise.all(
        batch.map((candidate) =>
          // `shouldRemindNow` already rejected a null zone, so the assertion is
          // the type system catching up with a check that has happened.
          this.remindOne(now, candidate.userId, candidate.timezone as string).catch((error) => {
            logger.warn(
              { userId: candidate.userId, error: error instanceof Error ? error.message : error },
              'Payment reminder failed for one user; continuing'
            );
            return null;
          })
        )
      );
      for (const result of results) {
        if (!result) continue;
        summary.silent += result.silent ? 1 : 0;
        summary.notified += result.notified ? 1 : 0;
        summary.sent += result.sent;
        summary.pruned += result.pruned;
        summary.failed += result.failed;
        summary.suppressed += result.suppressed;
      }
    }

    if (summary.missingTimezone > 0) {
      logger.warn(
        { missingTimezone: summary.missingTimezone, candidates: summary.candidates },
        '🕓 Subscribed users with no timezone were skipped — they can never be reminded until the app reports one'
      );
    }
    return summary;
  }

  private async remindOne(
    now: Date,
    userId: string,
    timezone: string
  ): Promise<{
    silent: boolean;
    notified: boolean;
    sent: number;
    pruned: number;
    failed: number;
    suppressed: number;
  }> {
    const tomorrow = localTomorrow(now, timezone);
    const occurrences = await this.occurrences.findDueOnDateForUser(userId, tomorrow);
    const totals = summariseForTomorrow(now, timezone, occurrences);

    // Silence when nothing is due. A daily notification that is usually empty
    // is a daily notification that gets its permission revoked, and "0
    // payments due tomorrow" is a sentence nobody needs read to them.
    if (totals.count === 0) {
      return { silent: true, notified: false, sent: 0, pruned: 0, failed: 0, suppressed: 0 };
    }

    const devices = await this.subscriptions.findByUser(userId);
    const cutoff = new Date(now.getTime() - REMINDER_COOLDOWN_MS);
    const fresh = devices.filter((d) => !d.lastSentAt || d.lastSentAt < cutoff);

    const payload = {
      title: 'Scani',
      body: reminderBody(totals),
      url: REMINDER_TARGET_PATH,
      // Same tag for the same local day, so a delivery the cooldown did not
      // catch REPLACES the earlier one on the lock screen instead of stacking
      // beside it.
      tag: `payment-due-${tomorrow}`,
    };

    const outcomes = await Promise.all(
      fresh.map(async (device) => ({
        id: device.id,
        result: await this.pushSender.send(
          { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
          payload
        ),
      }))
    );

    const sentIds = outcomes.filter((o) => o.result.status === 'sent').map((o) => o.id);
    const goneIds = outcomes.filter((o) => o.result.status === 'gone').map((o) => o.id);
    const failed = outcomes.filter(
      (o) => o.result.status === 'failed' || o.result.status === 'not-configured'
    ).length;

    await this.subscriptions.markSent(sentIds, now);
    const pruned = await this.subscriptions.deleteByIds(goneIds);

    return {
      silent: false,
      notified: sentIds.length > 0,
      sent: sentIds.length,
      pruned,
      failed,
      suppressed: devices.length - fresh.length,
    };
  }
}
