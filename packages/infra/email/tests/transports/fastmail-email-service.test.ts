import { describe, expect, test } from 'bun:test';
import { FastmailEmailService } from '../../src/transports/fastmail-email-service';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(responses: Array<() => Response>): {
  fetcher: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[i++];
    if (!next) throw new Error(`no response queued for fetch call #${i}`);
    return next();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const sessionResponse = () =>
  new Response(
    JSON.stringify({
      apiUrl: 'https://api.fastmail.com/jmap/api/',
      primaryAccounts: { 'urn:ietf:params:jmap:submission': 'acc-1' },
    }),
    { status: 200 }
  );

const identitiesResponse = () =>
  new Response(
    JSON.stringify({
      methodResponses: [
        ['Identity/get', { list: [{ id: 'id-1', email: 'welcome@scani.xyz' }] }, 'i0'],
      ],
    }),
    { status: 200 }
  );

const draftsResponse = () =>
  new Response(
    JSON.stringify({
      methodResponses: [['Mailbox/query', { ids: ['drafts-1'] }, 'm0']],
    }),
    { status: 200 }
  );

const okSendResponse = () =>
  new Response(
    JSON.stringify({
      methodResponses: [
        ['Email/set', { created: { e1: { id: 'sent-1' } } }, 'e1'],
        ['EmailSubmission/set', { created: { s1: { id: 'sub-1' } } }, 's1'],
      ],
    }),
    { status: 200 }
  );

describe('FastmailEmailService', () => {
  test('Authorization header carries the API token', async () => {
    const { fetcher, calls } = makeFakeFetch([
      sessionResponse,
      identitiesResponse,
      draftsResponse,
      okSendResponse,
    ]);
    const svc = new FastmailEmailService({ apiToken: 'my-token', fetcher });
    await svc.send({
      from: 'welcome@scani.xyz',
      to: 'alice@example.com',
      subject: 's',
      text: 't',
    });
    for (const call of calls) {
      const headers = (call.init.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer my-token');
    }
  });

  test('caches the JMAP session across multiple sends', async () => {
    const { fetcher, calls } = makeFakeFetch([
      sessionResponse,
      identitiesResponse,
      draftsResponse,
      okSendResponse,
      okSendResponse,
    ]);
    const svc = new FastmailEmailService({ apiToken: 't', fetcher });
    await svc.send({ from: 'welcome@scani.xyz', to: 'a@x', subject: 's', text: 't' });
    await svc.send({ from: 'welcome@scani.xyz', to: 'b@x', subject: 's', text: 't' });
    // 4 calls total: session + identities + drafts (one-time bootstrap) +
    // 2 sends. The second `send` reuses the cached bootstrap.
    expect(calls.length).toBe(5);
  });

  test('throws on JMAP error status', async () => {
    const { fetcher } = makeFakeFetch([
      sessionResponse,
      identitiesResponse,
      draftsResponse,
      () => new Response('boom', { status: 500 }),
    ]);
    const svc = new FastmailEmailService({ apiToken: 't', fetcher });
    await expect(
      svc.send({ from: 'welcome@scani.xyz', to: 'a@x', subject: 's', text: 't' })
    ).rejects.toThrow(/JMAP send failed: 500/);
  });

  test('throws when JMAP returns notCreated for Email/set', async () => {
    const { fetcher } = makeFakeFetch([
      sessionResponse,
      identitiesResponse,
      draftsResponse,
      () =>
        new Response(
          JSON.stringify({
            methodResponses: [
              ['Email/set', { notCreated: { e1: { type: 'invalidEmail' } } }, 'e1'],
              ['EmailSubmission/set', {}, 's1'],
            ],
          }),
          { status: 200 }
        ),
    ]);
    const svc = new FastmailEmailService({ apiToken: 't', fetcher });
    await expect(
      svc.send({ from: 'welcome@scani.xyz', to: 'a@x', subject: 's', text: 't' })
    ).rejects.toThrow(/JMAP Email\/set errors/);
  });

  test('picks wildcard identity when no exact match exists', async () => {
    const { fetcher, calls } = makeFakeFetch([
      sessionResponse,
      () =>
        new Response(
          JSON.stringify({
            methodResponses: [
              [
                'Identity/get',
                {
                  list: [
                    { id: 'id-other', email: 'other@elsewhere.io' },
                    { id: 'id-wild', email: '*@scani.xyz' },
                  ],
                },
                'i0',
              ],
            ],
          }),
          { status: 200 }
        ),
      draftsResponse,
      okSendResponse,
    ]);
    const svc = new FastmailEmailService({ apiToken: 't', fetcher });
    await svc.send({
      from: '"Welcome" <welcome@scani.xyz>',
      to: 'a@x',
      subject: 's',
      text: 't',
    });
    const sendBody = JSON.parse(String(calls[3]?.init.body));
    expect(sendBody.methodCalls[1][1].create.s1.identityId).toBe('id-wild');
  });
});
