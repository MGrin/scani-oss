import { describe, expect, test } from 'bun:test';
import { EmailService } from '../src/email-service';
import { type EmailMessage, SCANI_BRAND, SCANI_CLOUD_BRAND } from '../src/types';

class CapturingEmailService extends EmailService {
  public sent: EmailMessage[] = [];
  protected async sendMessage(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe('EmailService — high-level methods', () => {
  test('sendMagicLink uses SCANI_BRAND.from by default', async () => {
    const svc = new CapturingEmailService();
    await svc.sendMagicLink({ to: 'alice@example.com', url: 'https://x' });
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0]?.from).toBe(SCANI_BRAND.from);
    expect(svc.sent[0]?.to).toBe('alice@example.com');
    expect(svc.sent[0]?.subject).toBe('Sign in to Scani');
  });

  test('sendMagicLink honors a custom brand', async () => {
    const svc = new CapturingEmailService();
    await svc.sendMagicLink({
      to: 'op@example.com',
      url: 'https://cloud.scani.xyz/auth',
      brand: SCANI_CLOUD_BRAND,
    });
    expect(svc.sent[0]?.from).toBe(SCANI_CLOUD_BRAND.from);
    expect(svc.sent[0]?.subject).toBe('Sign in to Scani Cloud');
  });

  test('sendVerificationEmail produces the verification subject', async () => {
    const svc = new CapturingEmailService();
    await svc.sendVerificationEmail({ to: 'a@x', url: 'https://x' });
    expect(svc.sent[0]?.subject.startsWith('Verify your email')).toBe(true);
  });

  test('sendOtp passes through the OTP type to the template', async () => {
    const svc = new CapturingEmailService();
    await svc.sendOtp({ to: 'a@x', code: '424242', type: 'forget-password' });
    expect(svc.sent[0]?.html).toContain('Reset your password');
    expect(svc.sent[0]?.html).toContain('424242');
  });

  test('send() bypasses templating and forwards the message verbatim', async () => {
    const svc = new CapturingEmailService();
    await svc.send({
      from: 'custom@example.com',
      to: 'b@x',
      subject: 'pre-rendered',
      text: 'body',
      html: '<p>body</p>',
    });
    expect(svc.sent[0]).toEqual({
      from: 'custom@example.com',
      to: 'b@x',
      subject: 'pre-rendered',
      text: 'body',
      html: '<p>body</p>',
    });
  });
});
