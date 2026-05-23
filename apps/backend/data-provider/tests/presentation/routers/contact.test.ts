import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type EmailMessage, EmailService, LocalEmailService } from '@scani/email';
import { Container } from 'typedi';
import { contactRouter } from '../../../src/presentation/routers/contact';
import { buildUnauthedContext } from '../../helpers/test-context';

// The contact router is `publicProcedure` — no bearer token. A call passes
// through three gates: zod validation → in-memory rate limiter (5/h/IP) →
// the ops-email send. We stand in a fake email service so submissions
// don't hit SMTP, can be inspected, and can be made to fail on demand.
//
// Extends the real EmailService so it inherits send() + sendBranded() and
// every message — ops notification and branded receipt alike — funnels
// through the single sendMessage() seam.
class FakeEmailService extends EmailService {
  readonly sent: EmailMessage[] = [];
  failNext = false;
  protected async sendMessage(message: EmailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated SMTP failure');
    }
    this.sent.push(message);
  }
}

let fake: FakeEmailService;

beforeEach(() => {
  fake = new FakeEmailService();
  Container.set(LocalEmailService, fake);
});

afterEach(() => {
  Container.set(LocalEmailService, new LocalEmailService());
});

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Jane Doe',
    email: 'jane@example.com',
    topic: 'support' as const,
    message: 'I would like help connecting my exchange account.',
    ...overrides,
  };
}

describe('contactRouter.submit — input validation', () => {
  test('rejects an empty name with BAD_REQUEST', async () => {
    const caller = contactRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.10' }));
    await expect(caller.submit(validInput({ name: '' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  test('rejects an invalid email shape with BAD_REQUEST', async () => {
    const caller = contactRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.11' }));
    await expect(caller.submit(validInput({ email: 'not-an-email' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  test('rejects a too-short message with BAD_REQUEST', async () => {
    const caller = contactRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.12' }));
    await expect(caller.submit(validInput({ message: 'hi' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('contactRouter.submit — delivery', () => {
  test('delivers the ops notification to the support inbox and a receipt to the sender', async () => {
    const caller = contactRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.20' }));
    const res = await caller.submit(validInput());

    expect(res).toEqual({ ok: true });
    expect(fake.sent).toHaveLength(2);

    const ops = fake.sent[0];
    expect(ops?.to).toBe('support@example.com');
    expect(ops?.subject).toBe('[Support] Contact form — Jane Doe');
    expect(ops?.text).toContain('jane@example.com');

    const receipt = fake.sent[1];
    expect(receipt?.to).toBe('jane@example.com');
  });

  test('surfaces INTERNAL_SERVER_ERROR when the ops notification fails to send', async () => {
    fake.failNext = true;
    const caller = contactRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.21' }));
    await expect(caller.submit(validInput())).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('contactRouter.submit — rate limiting', () => {
  test('caps the 6th submission from the same IP at TOO_MANY_REQUESTS', async () => {
    const caller = contactRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.99' }));

    for (let i = 0; i < 5; i++) {
      await expect(caller.submit(validInput({ email: `r${i}@example.com` }))).resolves.toEqual({
        ok: true,
      });
    }

    await expect(caller.submit(validInput({ email: 'r6@example.com' }))).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});
