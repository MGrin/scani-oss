import { type AnalyticsApp, applyEmailTracking } from '@scani/analytics';
import { renderMagicLinkEmail, renderOtpEmail, renderVerificationEmail } from './templates';
import {
  type EmailBrand,
  type EmailContent,
  type EmailMessage,
  type OtpType,
  SCANI_BRAND,
} from './types';

// The cloud brand serves cloud.scani.xyz; everything else is the main app.
// Used only to tag which product surface an email belongs to.
function surfaceForBrand(brand: EmailBrand): AnalyticsApp {
  return brand.appUrl.includes('cloud.') ? 'cloud' : 'app';
}

export abstract class EmailService {
  protected abstract sendMessage(message: EmailMessage): Promise<void>;

  async sendMagicLink(input: { to: string; url: string; brand?: EmailBrand }): Promise<void> {
    const brand = input.brand ?? SCANI_BRAND;
    await this.deliver({
      to: input.to,
      template: 'magic-link',
      app: surfaceForBrand(brand),
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
      template: 'verification',
      app: surfaceForBrand(brand),
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
      template: `otp-${input.type}`,
      app: surfaceForBrand(brand),
      brand,
      content: renderOtpEmail({ brand, code: input.code, type: input.type }),
    });
  }

  // Sends a caller-rendered branded email with open/click tracking applied.
  // For marketing/transactional emails (waitlist, contact) that render
  // their own content rather than using the auth-template helpers above.
  async sendTracked(input: {
    to: string;
    template: string;
    app: AnalyticsApp;
    brand: EmailBrand;
    content: EmailContent;
  }): Promise<void> {
    await this.deliver(input);
  }

  // Direct send for callers that already hold a rendered EmailMessage —
  // the data-provider's `email.send` tRPC relay, which receives a payload
  // (already tracking-rewritten upstream) from a remote api in cloud mode.
  // Deliberately untracked so relayed messages aren't counted twice.
  async send(message: EmailMessage): Promise<void> {
    await this.sendMessage(message);
  }

  // Single tracking-aware delivery path: applyEmailTracking rewrites
  // links + appends an open pixel when configured and fires `email_sent`;
  // the rendered HTML then goes to the concrete transport.
  private async deliver(input: {
    to: string;
    template: string;
    app: AnalyticsApp;
    brand: EmailBrand;
    content: EmailContent;
  }): Promise<void> {
    const { html } = applyEmailTracking({
      to: input.to,
      template: input.template,
      app: input.app,
      html: input.content.html,
    });
    await this.sendMessage({
      from: input.brand.from,
      to: input.to,
      subject: input.content.subject,
      text: input.content.text,
      html,
    });
  }
}
