import { db } from '@scani/db';
import { users } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { count } from 'drizzle-orm';

const log = createComponentLogger('founder-alerts');

// One-shot per process so a permanently-over-cap deployment doesn't
// spam the log on every signup.
let capLogged = false;

const DEFAULT_CAP = 100;

// Decoupled from @scani/email / @scani/cloud-client by design: importing
// either would create a runtime cycle (email imports analytics for
// applyEmailTracking → analytics importing the email facade closes the
// loop and TDZ-errors EmailService). Caller passes whatever email
// transport it already holds.
export interface FounderAlertEmailSender {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

export async function notifyFounderOfNewUser(
  user: {
    id: string;
    email?: string | null;
    createdAt?: Date | null;
  },
  email: FounderAlertEmailSender
): Promise<void> {
  const to = process.env.WAITLIST_OPS_EMAIL;
  if (!to) return;
  const from = process.env.WAITLIST_OPS_FROM ?? 'no-reply@scani.xyz';
  const cap = Number(process.env.FOUNDER_NOTIFY_USER_CAP ?? DEFAULT_CAP);

  try {
    const [row] = await db.select({ c: count() }).from(users);
    const c = row?.c ?? 0;
    if (c > cap) {
      if (!capLogged) {
        log.info({ cap, count: c }, 'founder alert cap reached, skipping');
        capLogged = true;
      }
      return;
    }
    await email.send({
      from,
      to,
      subject: `New Scani signup #${c}/${cap}: ${user.email ?? user.id}`,
      text: [
        `Email: ${user.email ?? '(unknown)'}`,
        `User id: ${user.id}`,
        `Signup #: ${c} of ${cap}`,
        `Signed up: ${user.createdAt?.toISOString() ?? new Date().toISOString()}`,
      ].join('\n'),
    });
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to send founder new-user notification'
    );
  }
}
