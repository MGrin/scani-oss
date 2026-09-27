import { connect } from 'node:net';
import { createComponentLogger } from '@scani/logging';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { EmailService } from '../email-service';
import type { EmailMessage } from '../types';

const log = createComponentLogger('email:smtp');

export class SmtpEmailService extends EmailService {
  private transport: Transporter | null = null;

  constructor(private readonly opts: { url: string; transportFactory?: typeof createTransport }) {
    super();
  }

  protected async sendMessage(input: EmailMessage, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      if (!signal) await this.getTransport().sendMail(input);
      else {
        // Nodemailer needs a Node-compatible socket; destroying it also cancels STARTTLS.
        const factory = this.opts.transportFactory ?? createTransport;
        const transport = factory(this.opts.url);
        const smtp = transport.transporter as SMTPTransport;
        smtp.getSocket = (options, callback) => {
          if (signal.aborted) return callback(new Error('SMTP operation expired'), {});
          const socket = connect({
            host: options.host ?? 'localhost',
            port: Number(options.port) || (options.secure ? 465 : 587),
            signal,
          });
          let settled = false;
          socket.once('error', (error) => {
            if (!settled) {
              settled = true;
              callback(error, {});
            }
          });
          socket.once('connect', () => {
            if (!settled) {
              settled = true;
              callback(null, { connection: socket });
            }
          });
        };
        try {
          await transport.sendMail(input);
        } finally {
          transport.close();
        }
      }
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
