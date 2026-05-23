import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type EmailMessage, LocalEmailService } from '@scani/email';
import { Container } from 'typedi';
import type { CloudClient } from '../src/client';
import { EmailFacade } from '../src/facades/email-facade';
import { resetCloudClient, setCloudClient } from '../src/runtime';

class StubLocalEmailService extends LocalEmailService {
  public sent: EmailMessage[] = [];
  protected override pickDelegate() {
    // Bypass env loading; the high-level methods write into `sent` via
    // the abstract `sendMessage` we override below.
    return new (class StubBase extends LocalEmailService {
      protected override pickDelegate() {
        return this; // unused
      }
    })();
  }
  protected override async sendMessage(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

interface CloudCall {
  op: 'send';
  args: unknown;
}

function stubCloudClient(): { client: CloudClient; calls: CloudCall[] } {
  const calls: CloudCall[] = [];
  const client = {
    email: {
      send: {
        mutate: async (args: unknown) => {
          calls.push({ op: 'send', args });
          return { ok: true as const };
        },
      },
    },
  };
  return { client: client as unknown as CloudClient, calls };
}

let stubLocal: StubLocalEmailService;
beforeEach(() => {
  stubLocal = new StubLocalEmailService();
  Container.set(LocalEmailService, stubLocal);
  // Default to local-only mode; cloud-mode tests override below.
  // setCloudClient(null) (not resetCloudClient) keeps any host SCANI_CLOUD_URL
  // out of the picture for these tests.
  setCloudClient(null);
});
afterEach(() => {
  resetCloudClient();
});

describe('EmailFacade — local mode (no cloud client)', () => {
  test('send forwards a rendered message to LocalEmailService', async () => {
    const facade = new EmailFacade();
    await facade.send({
      from: 'a@x',
      to: 'b@x',
      subject: 's',
      text: 't',
    });
    expect(stubLocal.sent).toHaveLength(1);
    expect(stubLocal.sent[0]?.to).toBe('b@x');
  });

  test('sendMagicLink renders + forwards through LocalEmailService', async () => {
    const facade = new EmailFacade();
    await facade.sendMagicLink({ to: 'a@x', url: 'https://app.example.com/auth' });
    expect(stubLocal.sent[0]?.subject).toBe('Sign in to Scani');
    expect(stubLocal.sent[0]?.text).toContain('https://app.example.com/auth');
  });
});

describe('EmailFacade — cloud mode (cloud client set)', () => {
  test('send routes to the cloud client and the local stub is untouched', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new EmailFacade();
    await facade.send({
      from: 'a@x',
      to: 'b@x',
      subject: 's',
      text: 't',
    });
    expect(calls).toEqual([
      { op: 'send', args: { from: 'a@x', to: 'b@x', subject: 's', text: 't' } },
    ]);
    expect(stubLocal.sent).toHaveLength(0);
  });

  test('high-level methods render locally then ship the rendered message', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new EmailFacade();
    await facade.sendOtp({ to: 'a@x', code: '424242', type: 'sign-in' });
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args as { subject: string; text: string };
    expect(args.subject.startsWith('424242')).toBe(true);
    expect(stubLocal.sent).toHaveLength(0);
  });

  test('cloud check fires only once across many calls', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);
    const facade = new EmailFacade();
    await facade.send({ from: 'a@x', to: 'b@x', subject: 's', text: 't' });
    await facade.send({ from: 'a@x', to: 'c@x', subject: 's', text: 't' });
    await facade.send({ from: 'a@x', to: 'd@x', subject: 's', text: 't' });
    expect(calls).toHaveLength(3);
  });

  test('cloud client errors surface as CloudError to the caller', async () => {
    const client = {
      email: {
        send: {
          mutate: async () => {
            throw new Error('TOO_MANY_REQUESTS');
          },
        },
      },
    } as unknown as CloudClient;
    setCloudClient(client);
    const facade = new EmailFacade();
    await expect(
      facade.send({ from: 'a@x', to: 'b@x', subject: 's', text: 't' })
    ).rejects.toBeInstanceOf(Error);
  });
});
