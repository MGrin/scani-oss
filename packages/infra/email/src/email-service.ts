import { renderMagicLinkEmail, renderOtpEmail, renderVerificationEmail } from './templates';
import { type EmailBrand, type EmailMessage, type OtpType, SCANI_BRAND } from './types';

export abstract class EmailService {
  protected abstract sendMessage(message: EmailMessage): Promise<void>;

  async sendMagicLink(input: { to: string; url: string; brand?: EmailBrand }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    const rendered = renderMagicLinkEmail({ brand, url: input.url });
    await this.sendMessage({ from: brand.from, to: input.to, ...rendered });
  }

  async sendVerificationEmail(input: {
    to: string;
    url: string;
    brand?: EmailBrand;
  }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    const rendered = renderVerificationEmail({ brand, url: input.url });
    await this.sendMessage({ from: brand.from, to: input.to, ...rendered });
  }

  async sendOtp(input: {
    to: string;
    code: string;
    type: OtpType;
    brand?: EmailBrand;
  }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    const rendered = renderOtpEmail({ brand, code: input.code, type: input.type });
    await this.sendMessage({ from: brand.from, to: input.to, ...rendered });
  }

  // Direct send for callers that already hold a rendered EmailMessage —
  // currently the data-provider's `email.send` tRPC route, which receives
  // a fully-rendered payload from a remote api in cloud mode.
  async send(message: EmailMessage): Promise<void> {
    await this.sendMessage(message);
  }
}
