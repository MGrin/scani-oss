import { describe, expect, test } from 'bun:test';
import { LoggingEmailService } from '../../src/transports/logging-email-service';

describe('LoggingEmailService', () => {
  test('returns without throwing for any well-formed message', async () => {
    const svc = new LoggingEmailService();
    await expect(
      svc.send({
        from: 'a@x',
        to: 'b@x',
        subject: 'subj',
        text: 'body',
      })
    ).resolves.toBeUndefined();
  });

  test('handles HTML-only messages too', async () => {
    const svc = new LoggingEmailService();
    await expect(
      svc.send({
        from: 'a@x',
        to: 'b@x',
        subject: 'subj',
        text: 'plain',
        html: '<p>html</p>',
      })
    ).resolves.toBeUndefined();
  });
});
