import { type EmailMessage, EmailService } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { type RetryOptions, withRetry } from '@scani/rate-limiter';
import type { CloudClient } from '../client';
import { CloudError } from '../errors';

const log = createComponentLogger('cloud-client:email');

// Every auth email — magic link, OTP, verification — crosses this call,
// and the magic-link/OTP sends are awaited *inside* the sign-in request.
// So the budget is what a person will wait in front of a "sending…"
// spinner, not what would cover a machine replacement: 3 attempts,
// ~1.25s of backoff (250ms, then 1s).
//
// That covers a proxy blip or a single 5xx. It deliberately does NOT
// cover a data-provider deploy cutover, which is tens of seconds on a
// one-machine app. Closing that window needs a second machine, not
// a longer wait here — see SC-162.
const SEND_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 1000,
};

export class CloudEmailService extends EmailService {
  // A field rather than a module constant so a test can drive the
  // give-up path without paying the real backoff in wall-clock.
  protected readonly retryPolicy: RetryOptions = SEND_RETRY;

  constructor(private readonly client: CloudClient) {
    super();
  }

  protected async sendMessage(message: EmailMessage): Promise<void> {
    await withRetry(
      async () => {
        try {
          await this.client.email.send.mutate({
            from: message.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          });
        } catch (err) {
          throw CloudError.wrap(err);
        }
      },
      {
        ...this.retryPolicy,
        // `CloudError.retryable` has been computed on every wrap since the
        // class was written and read by nothing. This is its reader: a
        // rejected payload or a bad api key is `false` and surfaces on the
        // first attempt; a timeout, a 429, a 5xx, or a data-provider that
        // answered nothing at all is `true`.
        isTransient: (err) => err instanceof CloudError && err.retryable,
        onRetry: (attempt, err) => {
          log.warn(
            {
              attempt,
              code: err instanceof CloudError ? err.code : undefined,
              error: err instanceof Error ? err.message : String(err),
            },
            'Cloud email send failed; retrying'
          );
        },
      }
    );
  }
}
