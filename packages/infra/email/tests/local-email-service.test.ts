import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetEmailConfig } from '../src/config';
import { LocalEmailService } from '../src/local-email-service';
import { FastmailEmailService } from '../src/transports/fastmail-email-service';
import { LoggingEmailService } from '../src/transports/logging-email-service';
import { SmtpEmailService } from '../src/transports/smtp-email-service';

class Spy extends LocalEmailService {
  public override pickDelegate() {
    return super.pickDelegate();
  }
}

const restore: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    restore[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  resetEmailConfig();
});
afterEach(() => {
  for (const [k, v] of Object.entries(restore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEmailConfig();
});

describe('LocalEmailService — transport selection', () => {
  test('FASTMAIL_API_TOKEN wins when present', () => {
    setEnv({
      FASTMAIL_API_TOKEN: 'tok',
      SMTP_URL: 'smtp://x',
      SMTP_FROM: undefined,
    });
    const svc = new Spy();
    expect(svc.pickDelegate()).toBeInstanceOf(FastmailEmailService);
  });

  test('SMTP_URL falls in when no Fastmail token', () => {
    setEnv({
      FASTMAIL_API_TOKEN: undefined,
      SMTP_URL: 'smtp://localhost:1025',
      SMTP_FROM: undefined,
    });
    const svc = new Spy();
    expect(svc.pickDelegate()).toBeInstanceOf(SmtpEmailService);
  });

  test('Logging fallback when neither is set', () => {
    setEnv({
      FASTMAIL_API_TOKEN: undefined,
      SMTP_URL: undefined,
      SMTP_FROM: undefined,
    });
    const svc = new Spy();
    expect(svc.pickDelegate()).toBeInstanceOf(LoggingEmailService);
  });

  test('SMTP_FROM env overrides default brand from when sending', async () => {
    setEnv({
      FASTMAIL_API_TOKEN: undefined,
      SMTP_URL: undefined,
      SMTP_FROM: 'override@elsewhere.io',
    });
    const captured: { from?: string } = {};
    class Capturing extends LocalEmailService {
      protected override pickDelegate() {
        return new (class extends LoggingEmailService {
          override async send(m: import('../src/types').EmailMessage) {
            captured.from = m.from;
          }
        })();
      }
    }
    const svc = new Capturing();
    await svc.sendMagicLink({ to: 'a@x', url: 'https://x' });
    expect(captured.from).toBe('override@elsewhere.io');
  });
});
