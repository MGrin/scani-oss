import { describe, expect, mock, test } from 'bun:test';
import { SmtpEmailService } from '../../src/transports/smtp-email-service';

describe('SmtpEmailService', () => {
  test('builds the transport once and reuses it across sends', async () => {
    const sendMail = mock(() => Promise.resolve({ messageId: 'a' }));
    const factory = mock(() => ({ sendMail }) as never);
    const svc = new SmtpEmailService({ url: 'smtp://localhost:1025', transportFactory: factory });
    await svc.send({ from: 'a@x', to: 'b@x', subject: 's', text: 't' });
    await svc.send({ from: 'a@x', to: 'c@x', subject: 's', text: 't' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  test('forwards the message payload verbatim to nodemailer', async () => {
    const sendMail = mock(() => Promise.resolve({ messageId: 'a' }));
    const factory = mock(() => ({ sendMail }) as never);
    const svc = new SmtpEmailService({ url: 'smtp://localhost', transportFactory: factory });
    await svc.send({
      from: 'sender@x',
      to: 'recv@x',
      subject: 'subj',
      text: 'plain',
      html: '<p>html</p>',
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'sender@x',
      to: 'recv@x',
      subject: 'subj',
      text: 'plain',
      html: '<p>html</p>',
    });
  });

  test('propagates transport errors to the caller', async () => {
    const sendMail = mock(() => Promise.reject(new Error('boom')));
    const factory = mock(() => ({ sendMail }) as never);
    const svc = new SmtpEmailService({ url: 'smtp://localhost', transportFactory: factory });
    await expect(svc.send({ from: 'a@x', to: 'b@x', subject: 's', text: 't' })).rejects.toThrow(
      'boom'
    );
  });
});
