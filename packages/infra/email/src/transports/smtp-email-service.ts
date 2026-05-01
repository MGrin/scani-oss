import { createComponentLogger } from '@scani/logging';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailService } from '../email-service';
import type { EmailMessage } from '../types';

const log = createComponentLogger('email:smtp');

export class SmtpEmailService extends EmailService {
  private transport: Transporter | null = null;

  constructor(private readonly opts: { url: string; transportFactory?: typeof createTransport }) {
    super();
  }

  protected async sendMessage(input: EmailMessage): Promise<void> {
    try {
      await this.getTransport().sendMail(input);
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err), to: input.to },
        'SMTP send failed'
      );
      throw err;
    }
  }

  private getTransport(): Transporter {
    if (this.transport) return this.transport;
    const factory = this.opts.transportFactory ?? createTransport;
    this.transport = factory(this.opts.url);
    return this.transport;
  }
}
