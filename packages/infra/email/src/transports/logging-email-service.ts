import { createComponentLogger } from '@scani/logging';
import { EmailService } from '../email-service';
import type { EmailMessage } from '../types';

const log = createComponentLogger('email:logging');

// Last-resort fallback when no transport env is set. Logs the rendered
// message to stdout so a contributor running the stack without Fastmail /
// SMTP can still grab the magic link / OTP from `docker logs`. Production
// boot must never reach this — apps surface a clear warning when it does.
export class LoggingEmailService extends EmailService {
  protected async sendMessage(input: EmailMessage): Promise<void> {
    log.warn(
      { to: input.to, subject: input.subject, from: input.from },
      'no email transport configured — logging message body to stdout (dev-only fallback)'
    );
    log.info({ to: input.to, body: input.text }, input.subject);
  }
}
