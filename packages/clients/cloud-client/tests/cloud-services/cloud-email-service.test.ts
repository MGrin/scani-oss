import { describe, expect, test } from 'bun:test';
import type { RetryOptions } from '@scani/rate-limiter';
import type { CloudClient } from '../../src/client';
import { CloudEmailService } from '../../src/cloud-services/cloud-email-service';
import { CloudError } from '../../src/errors';

const MESSAGE = { from: 'a@x', to: 'b@x', subject: 's', text: 't' };

// Same shape as production, without the seconds of real backoff.
const FAST_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

class TestCloudEmailService extends CloudEmailService {
  protected override readonly retryPolicy = FAST_RETRY;
}

function clientThatFails(
  times: number,
  error: () => unknown
): { client: CloudClient; calls: () => number } {
  let attempts = 0;
  const client = {
    email: {
      send: {
        mutate: async () => {
          attempts += 1;
          if (attempts <= times) throw error();
          return { ok: true as const };
        },
      },
    },
  };
  return { client: client as unknown as CloudClient, calls: () => attempts };
}

// A data-provider that is mid-deploy answers nothing at all: the fetch
// rejects before any tRPC envelope exists. `CloudError.wrap` classifies
// that as retryable.
const unreachable = () => new Error('fetch failed');

describe('CloudEmailService', () => {
  test('a send that succeeds first time makes exactly one call', async () => {
    const { client, calls } = clientThatFails(0, unreachable);
    await new TestCloudEmailService(client).send(MESSAGE);
    expect(calls()).toBe(1);
  });

  test('an unreachable data-provider is retried and the send still lands', async () => {
    const { client, calls } = clientThatFails(2, unreachable);
    await new TestCloudEmailService(client).send(MESSAGE);
    expect(calls()).toBe(3);
  });

  test('the retry is bounded — it gives up and rethrows rather than looping', async () => {
    const { client, calls } = clientThatFails(99, unreachable);
    await expect(new TestCloudEmailService(client).send(MESSAGE)).rejects.toBeInstanceOf(
      CloudError
    );
    expect(calls()).toBe(3);
  });

  test('a permanent failure surfaces on the first attempt instead of burning the budget', async () => {
    const permanent = () => new CloudError('recipient rejected', 'BAD_REQUEST', null, false);
    const { client, calls } = clientThatFails(99, permanent);
    await expect(new TestCloudEmailService(client).send(MESSAGE)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls()).toBe(1);
  });

  test('the failure that reaches the caller is the real one, not a retry wrapper', async () => {
    const { client } = clientThatFails(
      99,
      () => new CloudError('upstream down', 'TIMEOUT', null, true)
    );
    await expect(new TestCloudEmailService(client).send(MESSAGE)).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'upstream down',
    });
  });

  test('the payload forwarded to the data-provider is unchanged by the retry wrapper', async () => {
    const seen: unknown[] = [];
    const client = {
      email: {
        send: {
          mutate: async (args: unknown) => {
            seen.push(args);
            return { ok: true as const };
          },
        },
      },
    } as unknown as CloudClient;
    await new TestCloudEmailService(client).send({ ...MESSAGE, html: '<p>t</p>' });
    expect(seen).toEqual([{ ...MESSAGE, html: '<p>t</p>' }]);
  });
});
