import { SendPaymentDueRemindersUseCase } from '@scani/domain/use-cases';
import { PAYMENT_DUE_REMINDER_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:payment-due-reminder');

/**
 * The hourly sweep behind SC-226's one-a-day reminder.
 *
 * Hourly is not a cadence choice, it is what "17:00 in the user's own local
 * time" costs: a daily fire happens at one UTC hour, and one UTC hour is a
 * different clock time in every zone. Each fire selects the users for whom it
 * is currently the reminder hour, so a user matches exactly one of their own
 * 24 and the other 23 are a comparison each.
 *
 * The descriptor's advisory lock (`lockName`) makes two overlapping fires
 * no-op rather than race. It does NOT make a retry safe on its own — a job
 * that sent half its pushes and then threw takes the lock cleanly on the
 * retry — so the use case additionally suppresses any device sent to inside
 * `REMINDER_COOLDOWN_MS`, and the payload carries a per-day `tag` so anything
 * that slips past both replaces the earlier notification instead of stacking
 * beside it.
 */
@Service()
export class PaymentDueReminderProcessor extends ScheduledJobProcessor {
  readonly descriptor = PAYMENT_DUE_REMINDER_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    try {
      const summary = await Container.get(SendPaymentDueRemindersUseCase).execute();
      // Logged even when everything is zero, and every counter is separate on
      // purpose: "0 notified" is produced by a deployment with no VAPID keys,
      // by a userbase with no timezone, and by a night when nothing is due,
      // and those three need different people to do different things.
      logger.info({ ...summary, totalMs: Date.now() - start }, '✅ Payment-due reminder sweep');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - start,
        },
        '❌ Payment-due reminder sweep failed'
      );
      throw error;
    }
  }
}
