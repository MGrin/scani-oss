import { Service } from 'typedi';
import { loadEmailConfig } from './config';
import { EmailService } from './email-service';
import { FastmailEmailService } from './transports/fastmail-email-service';
import { LoggingEmailService } from './transports/logging-email-service';
import { SmtpEmailService } from './transports/smtp-email-service';
import type { EmailMessage } from './types';

// Picks among the three local transports based on env. Priority order
// (Fastmail > SMTP > Logging) matches what api Better-Auth used to do
// inline; consolidated here so the same precedence applies whether the
// caller is api Better-Auth, data-provider Better-Auth, or the
// data-provider's email tRPC relay.
//
// Optional SMTP_FROM env overrides whichever `from` the high-level methods
// produced (default `brand.from` from SCANI_BRAND/SCANI_CLOUD_BRAND, or a
// custom brand the caller passed). The override exists so OSS self-hosters
// can switch the deliverability identity without forking the package.
@Service()
export class LocalEmailService extends EmailService {
  private readonly delegate: EmailService = this.pickDelegate();

  protected async sendMessage(message: EmailMessage): Promise<void> {
    const env = loadEmailConfig();
    const from = env.SMTP_FROM ?? message.from;
    await this.delegate.send({ ...message, from });
  }

  protected pickDelegate(): EmailService {
    const env = loadEmailConfig();
    if (env.FASTMAIL_API_TOKEN) {
      return new FastmailEmailService({ apiToken: env.FASTMAIL_API_TOKEN });
    }
    if (env.SMTP_URL) {
      return new SmtpEmailService({ url: env.SMTP_URL });
    }
    return new LoggingEmailService();
  }
}
