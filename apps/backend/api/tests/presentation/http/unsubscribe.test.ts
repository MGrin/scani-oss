import { describe, expect, test } from 'bun:test';
import { EMAIL_STREAMS, UserRepository } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { handleUnsubscribe } from '../../../src/presentation/http/unsubscribe';

restoreContainerAfterAll();

const TOKEN = '8b1f1a2e-0000-4000-8000-000000000000';

function stub(behaviour: { optOut?: (token: string) => Promise<boolean> }): {
  seen: Array<{ stream: string; token: string }>;
} {
  const seen: Array<{ stream: string; token: string }> = [];
  Container.set(UserRepository, {
    optOutByToken: async (stream: string, token: string) => {
      seen.push({ stream, token });
      return behaviour.optOut ? behaviour.optOut(token) : true;
    },
  });
  return { seen };
}

const digest = (token: string) => handleUnsubscribe(EMAIL_STREAMS.digest, token);

describe('handleUnsubscribe (SC-460, SC-459)', () => {
  test('a known token opts the account out in one GET, with no session', async () => {
    const { seen } = stub({});
    const response = await digest(TOKEN);

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ stream: 'digest', token: TOKEN }]);
    expect(await response.text()).toContain('Unsubscribed');
  });

  test('a malformed token never reaches the database', async () => {
    // `email_unsubscribe_token` is a uuid column; Postgres raises on a
    // malformed comparison rather than returning no rows, so an unchecked
    // token turns a 404 into a 500.
    const { seen } = stub({});
    const response = await digest('not-a-uuid');

    expect(response.status).toBe(404);
    expect(seen).toEqual([]);
  });

  test('an unknown token is a 404, not a silent success', async () => {
    stub({ optOut: async () => false });
    expect((await digest(TOKEN)).status).toBe(404);
  });

  test('a database failure says try again rather than claiming success', async () => {
    stub({
      optOut: async () => {
        throw new Error('connection refused');
      },
    });
    const response = await digest(TOKEN);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('Unsubscribed');
  });

  test('every response is HTML a mail client can render, and is never cached', async () => {
    stub({});
    const response = await digest(TOKEN);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('the alerts stream writes to its own column, not the digest one', async () => {
    const { seen } = stub({});
    const response = await handleUnsubscribe(EMAIL_STREAMS.alerts, TOKEN);

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ stream: 'alerts', token: TOKEN }]);
    expect(await response.text()).toContain('alerts about your connections');
  });

  test('each success page offers the OTHER stream, with the same token', async () => {
    // A reader who clicks "unsubscribe" usually means all of it. Finding out a
    // week later that it covered half is how a sender gets marked as spam.
    stub({});
    expect(await (await digest(TOKEN)).text()).toContain(`/e/a/${TOKEN}`);
    expect(await (await handleUnsubscribe(EMAIL_STREAMS.alerts, TOKEN)).text()).toContain(
      `/e/u/${TOKEN}`
    );
  });
});
