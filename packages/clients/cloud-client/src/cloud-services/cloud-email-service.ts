import { type EmailMessage, EmailService } from '@scani/email';
import type { CloudClient } from '../client';
import { CloudError } from '../errors';

export class CloudEmailService extends EmailService {
  constructor(private readonly client: CloudClient) {
    super();
  }

  protected async sendMessage(message: EmailMessage): Promise<void> {
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
  }
}
