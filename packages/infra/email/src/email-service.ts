import { renderMagicLinkEmail, renderOtpEmail, renderVerificationEmail } from './templates';
import {
  type EmailBrand,
  type EmailContent,
  type EmailMessage,
  type OtpType,
  SCANI_BRAND,
} from './types';

export abstract class EmailService {
  protected abstract sendMessage(message: EmailMessage): Promise<void>;

  async sendMagicLink(input: { to: string; url: string; brand?: EmailBrand }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    await this.deliver({
      to: input.to,
      brand,
      content: renderMagicLinkEmail({ brand, url: input.url }),
    });
  }

  async sendVerificationEmail(input: {
    to: string;
    url: string;
    brand?: EmailBrand;
  }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    await this.deliver({
      to: input.to,
      brand,
      content: renderVerificationEmail({ brand, url: input.url }),
    });
  }

  async sendOtp(input: {
    to: string;
    code: string;
    type: OtpType;
    brand?: EmailBrand;
  }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    await this.deliver({
      to: input.to,
      brand,
      content: renderOtpEmail({ brand, code: input.code, type: input.type }),
    });
  }

  // Sends a caller-rendered branded email — for transactional mail (e.g.
  // the contact-form receipt) that renders its own content rather than
  // using the auth-template helpers above.
  async sendBranded(input: {
    to: string;
    brand: EmailBrand;
    content: EmailContent;
  }): Promise<void> {
    await this.deliver(input);
  }

  // Direct send for callers that already hold a rendered EmailMessage —
  // the data-provider's `email.send` tRPC relay, which receives an
  // already-rendered payload from a remote api in cloud mode.
  async send(message: EmailMessage): Promise<void> {
    await this.sendMessage(message);
  }

  // Single delivery path: applies the brand's `from` address, then hands
  // the message to the concrete transport.
  private async deliver(input: {
    to: string;
    brand: EmailBrand;
    content: EmailContent;
  }): Promise<void> {
    await this.sendMessage({
      from: input.brand.from,
      to: input.to,
      subject: input.content.subject,
      text: input.content.text,
      html: input.content.html,
    });
  }
}
