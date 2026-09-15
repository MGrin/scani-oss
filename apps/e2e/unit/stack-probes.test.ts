import { afterAll, describe, expect, test } from 'bun:test';
import { MailpitClient } from '../fixtures/mailpit';
import { assertStackUp, STACK_PROBES } from '../fixtures/stack-probes';

/**
 * SC-796. With Mailpit stopped, `bun run visual` died with
 * `TypeError: fetch failed [cause]: AggregateError:` — no service, no URL.
 * The stack check listed api and frontend only, and the Mailpit client's bare
 * `fetch` threw before its own deadline message could print.
 */

/** A port that was listening a moment ago and is not now. */
function deadOrigin(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const origin = `http://localhost:${server.port}`;
  server.stop(true);
  return origin;
}

const live = Bun.serve({
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === '/api/v1/search'
      ? Response.json({
          messages: [{ ID: 'm1', From: { Address: 'a@x' }, To: [], Subject: '', Created: '' }],
        })
      : new Response('ok'),
});
const LIVE = `http://localhost:${live.port}`;
afterAll(() => live.stop(true));

describe('SC-796 — a missing service is refused by name', () => {
  test('the stack check probes mailpit', () => {
    expect(STACK_PROBES.map(([label]) => label)).toEqual(['api', 'frontend', 'mailpit']);
    expect(STACK_PROBES.find(([label]) => label === 'mailpit')?.[1]).toEndWith('/api/v1/info');
  });

  test('a dead probe names the service, the URL and the remedy', async () => {
    const url = `${deadOrigin()}/api/v1/info`;
    const failure = assertStackUp([
      ['frontend', LIVE],
      ['mailpit', url],
    ]);
    await expect(failure).rejects.toThrow(`mailpit not reachable at ${url}`);
    await expect(failure).rejects.toThrow('bun dev:stack');
  });

  test('control: live probes pass', async () => {
    await expect(assertStackUp([['mailpit', LIVE]])).resolves.toBeUndefined();
  });

  test('the Mailpit client names itself when Mailpit is down', async () => {
    const origin = deadOrigin();
    const failure = new MailpitClient(origin).waitForMessageTo('a@x', { timeoutMs: 2_000 });
    await expect(failure).rejects.toThrow(`mailpit not reachable at ${origin}/api/v1/search`);
  });

  test('control: the client still finds a message on a live Mailpit', async () => {
    const message = await new MailpitClient(LIVE).waitForMessageTo('a@x', { timeoutMs: 2_000 });
    expect(message.ID).toBe('m1');
  });
});
