import { afterEach, describe, expect, test } from 'bun:test';
import { ChunkLoadError } from '@scani/ui/lib/lazy-chunk';
import { reportClientError } from '@/lib/report-client-error';

/**
 * SC-1380. A chunk that would not load is the network or a deploy, not a bug,
 * so it is filed as a warning; everything else stays an error. The ordinary
 * error is the control: without it, a reporter that sent `warning` for
 * everything would pass the first test.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function levelSentFor(error: Error): Promise<unknown> {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{}');
  }) as typeof fetch;
  await reportClientError({ error });
  expect(bodies).toHaveLength(1);
  return bodies[0]?.level;
}

describe('reportClientError', () => {
  test('a chunk that would not load is sent as a warning', async () => {
    const error = new ChunkLoadError(
      'interface',
      new TypeError('Importing a module script failed.')
    );
    expect(await levelSentFor(error)).toBe('warning');
  });

  test('CONTROL: any other error sends no level, so the api files it as an error', async () => {
    expect(await levelSentFor(new TypeError('x is undefined'))).toBeUndefined();
  });
});
