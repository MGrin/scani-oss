import type { CloudClient } from '../index';
import { CloudError } from '../index';

/**
 * Outgoing-email adapter. Shape-matches `FastmailSender` from
 * `@scani/email` so Better-Auth's existing `sender.sendMail(...)` call
 * site is unchanged — we just swap the implementation at construction
 * time when cloud mode is on.
 */
export interface CloudEmailSender {
  sendMail(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void>;
}

export function createCloudEmailSender(client: CloudClient): CloudEmailSender {
  return {
    async sendMail(input) {
      try {
        await client.email.send.mutate(input);
      } catch (err) {
        throw CloudError.wrap(err);
      }
    },
  };
}
