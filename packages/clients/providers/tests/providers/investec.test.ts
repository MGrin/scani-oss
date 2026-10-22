import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../src/core/errors';
import { type NoticeInput, type TransactionFetchContext, toJobNotice } from '../../src/core/types';
import { InvestecProvider } from '../../src/providers/investec';
import { investecManifest } from '../../src/providers/investec/manifest';

/**
 * Investec South Africa Private Bank, read-only, for self-hosted Scani only
 * (SC-1731).
 *
 * The stubbed responses below are the shapes Investec's SANDBOX returned on
 * 2026-10-12 (`openapisandbox.investec.com`), trimmed to the fields the
 * connector reads. The live block at the end runs the same flow against that
 * sandbox when `SCANI_LIVE=1`.
 */

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

type Route = (call: Call) => Response | null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** Install a fetch that records every call and answers from `routes`. */
async function withInvestec<T>(routes: Route[], run: (calls: Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Call = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : init?.body?.toString(),
    };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    throw new Error(`unexpected Investec call: ${call.method} ${call.path}`);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const TOKEN_PATH = '/identity/v2/oauth2/token';
const READ_SCOPES = 'accounts balances transactions';

function tokenRoute(scope = READ_SCOPES): Route {
  return (call) =>
    call.method === 'POST' && call.path === TOKEN_PATH
      ? json({ access_token: 'access-token', token_type: 'Bearer', expires_in: 1799, scope })
      : null;
}

function account(accountId: string, productName: string) {
  return {
    accountId,
    accountNumber: '10011234567',
    accountName: 'A Customer',
    referenceName: 'A Customer',
    productName,
    kycCompliant: true,
    profileId: '10001234567890',
    profileName: 'A Customer',
  };
}

function accountsRoute(accounts: ReturnType<typeof account>[]): Route {
  return (call) =>
    call.method === 'GET' && call.path === '/za/pb/v1/accounts'
      ? json({ data: { accounts }, links: {}, meta: { totalPages: 1 } })
      : null;
}

function balanceRoute(balances: Record<string, { current: number; currency: string }>): Route {
  return (call) => {
    const match = /^\/za\/pb\/v1\/accounts\/([^/]+)\/balance$/.exec(call.path);
    const balance = match?.[1] ? balances[match[1]] : undefined;
    if (call.method !== 'GET' || !match?.[1] || !balance) return null;
    return json({
      data: {
        accountId: match[1],
        currentBalance: balance.current,
        availableBalance: balance.current,
        budgetBalance: 0,
        straightBalance: 0,
        cashBalance: 0,
        currency: balance.currency,
      },
      links: {},
      meta: { totalPages: 1 },
    });
  };
}

function transaction(
  uuid: string,
  type: 'DEBIT' | 'CREDIT',
  amount: number,
  postingDate: string,
  extra: Record<string, unknown> = {}
) {
  return {
    accountId: 'A1',
    type,
    transactionType: type === 'DEBIT' ? 'CardPurchases' : 'Deposits',
    status: 'POSTED',
    description: type === 'DEBIT' ? 'CORNER CAFE CAPE TOWN ZA' : 'SALARY',
    cardNumber: type === 'DEBIT' ? '400000xxxxxx0001' : '',
    postedOrder: 10600,
    postingDate,
    valueDate: postingDate,
    actionDate: postingDate,
    transactionDate: postingDate,
    amount,
    runningBalance: 1000,
    uuid,
    ...extra,
  };
}

function transactionsRoute(
  byAccount: Record<string, ReturnType<typeof transaction>[]>,
  totalPages = 1
): Route {
  return (call) => {
    const match = /^\/za\/pb\/v1\/accounts\/([^/]+)\/transactions(\?|$)/.exec(call.path);
    if (call.method !== 'GET' || !match?.[1]) return null;
    return json({
      data: { transactions: byAccount[match[1]] ?? [] },
      links: {},
      meta: { totalPages },
    });
  };
}

const CREDS = { clientId: 'client-id', clientSecret: 'client-secret', apiKey: 'api-key' };

function context(creds: Record<string, string>, extra: Partial<TransactionFetchContext> = {}) {
  return {
    institutionCode: 'investec',
    baseCurrency: { id: 'zar', symbol: 'ZAR' },
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => creds,
    ...extra,
  } as unknown as TransactionFetchContext;
}

describe('the Investec manifest', () => {
  test('asks for the client id, the client secret and the API key', () => {
    expect(investecManifest.credentialFields.map((f) => f.name)).toEqual([
      'clientId',
      'clientSecret',
      'apiKey',
    ]);
    expect(investecManifest.credentialFields.every((f) => f.sensitive)).toBe(true);
  });

  test("is marked self-hosted only: a platform for many clients needs Investec's own onboarding", () => {
    expect(investecManifest.selfHostedOnly).toBe(true);
  });

  // A rule, not a step: it sits under the list (design, SC-1731).
  test('states its read-only rule under the steps, not as one of them', () => {
    expect(investecManifest.instructions.note).toBe(
      'Scani refuses a key that can also transfer or pay.'
    );
    expect(investecManifest.instructions.steps.some((s) => s.includes('refuses'))).toBe(false);
  });

  test('imports Investec accounts as bank accounts', () => {
    expect(investecManifest.defaultAccountTypeCode).toBe('checking');
  });

  // Investec keys carry the scopes chosen at creation, and the connect step
  // refuses one that can transfer or pay. So the key Scani holds cannot move
  // money, unlike bunq's.
  test('declares that its key cannot move money', () => {
    expect(investecManifest.credentialCanMoveMoney).toBe(false);
  });
});

describe('InvestecProvider never writes', () => {
  test('a connect, a balance read and a transaction read POST only to the token endpoint', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(
      [
        tokenRoute(),
        accountsRoute([account('A1', 'Private Bank Account')]),
        balanceRoute({ A1: { current: 10, currency: 'ZAR' } }),
        transactionsRoute({ A1: [transaction('u1', 'DEBIT', 1, '2026-10-01')] }),
      ],
      async (calls) => {
        await p.validateCredentials(CREDS, 'investec');
        await p.fetchBalances(context(CREDS));
        await p.fetchTransactions(context(CREDS));
        const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every((w) => w === `POST ${TOKEN_PATH}`)).toBe(true);
        expect(calls.some((c) => c.method === 'GET')).toBe(true);
      }
    );
  });

  test('the source names no other POST, and no PUT, PATCH or DELETE at all', () => {
    const source = readFileSync(
      new URL('../../src/providers/investec/index.ts', import.meta.url),
      'utf8'
    );
    const posted = [...source.matchAll(/method:\s*'POST'[^}]*?path:\s*([A-Z_]+)/g)].map(
      (m) => m[1]
    );
    expect(posted).toEqual(['TOKEN_PATH']);
    expect(source).toContain(`const TOKEN_PATH = '${TOKEN_PATH}'`);
    expect(source).not.toMatch(/'(PUT|DELETE|PATCH)'/);
    expect(source).not.toMatch(/transfermultiple|paymultiple|beneficiar(y|ies)\//);
  });
});

describe('InvestecProvider.validateCredentials', () => {
  test("exchanges the client id and secret, with the API key, for a token in Investec's form", async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec([tokenRoute(), accountsRoute([])], async (calls) => {
      const result = await p.validateCredentials(CREDS, 'investec');
      expect(result.valid).toBe(true);
      const token = calls.find((c) => c.path === TOKEN_PATH);
      expect(token?.headers.authorization).toBe(
        `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`
      );
      expect(token?.headers['x-api-key']).toBe('api-key');
      expect(token?.body).toBe('grant_type=client_credentials');
      expect(calls.find((c) => c.path === '/za/pb/v1/accounts')?.headers.authorization).toBe(
        'Bearer access-token'
      );
    });
  });

  test.each([
    ['transfers', `${READ_SCOPES} transfers`],
    ['beneficiary payments', `${READ_SCOPES} beneficiarypayments`],
  ])('refuses a key that can make %s, before reading any account', async (_label, scope) => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec([tokenRoute(scope), accountsRoute([])], async (calls) => {
      const result = await p.validateCredentials(CREDS, 'investec');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('can move money');
      expect(calls.some((c) => c.path.startsWith('/za/'))).toBe(false);
    });
  });

  test('CONTROL: a key with read scopes and documents is accepted', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec([tokenRoute(`${READ_SCOPES} documents`), accountsRoute([])], async () => {
      expect((await p.validateCredentials(CREDS, 'investec')).valid).toBe(true);
    });
  });

  test('credentials Investec rejects are a verdict about the key', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    const rejected: Route = (call) =>
      call.path === TOKEN_PATH ? json({ error: 'invalid_client' }, 401) : null;
    await withInvestec([rejected], async () => {
      const result = await p.validateCredentials(CREDS, 'investec');
      expect(result.valid).toBe(false);
      expect(result.message).toBeTruthy();
    });
  });

  test('CONTROL: an outage is not a verdict — it throws, so the form says it could not check', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    const down: Route = (call) =>
      call.path === TOKEN_PATH ? new Response('', { status: 503 }) : null;
    await withInvestec([down], async () => {
      await expect(p.validateCredentials(CREDS, 'investec')).rejects.toBeInstanceOf(ProviderError);
    });
  });

  test('a missing field and the wrong institution are refused without asking Investec', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec([], async (calls) => {
      expect((await p.validateCredentials({ clientId: 'a', apiKey: 'b' }, 'investec')).valid).toBe(
        false
      );
      expect((await p.validateCredentials(CREDS, 'bunq')).valid).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('InvestecProvider.fetchBalances', () => {
  test('sums the current balance of every account per currency, and drops empty ones', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(
      [
        tokenRoute(),
        accountsRoute([
          account('A1', 'Private Bank Account'),
          account('A2', 'PrimeSaver'),
          account('A3', 'Cash Management Account'),
        ]),
        balanceRoute({
          A1: { current: 33607.16, currency: 'ZAR' },
          A2: { current: 1000.5, currency: 'ZAR' },
          A3: { current: 0, currency: 'USD' },
        }),
      ],
      async () => {
        const holdings = await p.fetchBalances(context(CREDS));
        expect(holdings.map((h) => [h.externalId, h.balance, h.tokenType])).toEqual([
          ['ZAR', '34607.66', 'fiat'],
        ]);
      }
    );
  });

  test('one token serves a balance read and a transaction read', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(
      [
        tokenRoute(),
        accountsRoute([account('A1', 'Private Bank Account')]),
        balanceRoute({ A1: { current: 10, currency: 'ZAR' } }),
        transactionsRoute({}),
      ],
      async (calls) => {
        await p.fetchBalances(context(CREDS));
        await p.fetchTransactions(context(CREDS));
        expect(calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(1);
      }
    );
  });

  test('a rate limit is classified as one', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    const limited: Route = (call) =>
      call.path === '/za/pb/v1/accounts' ? new Response('', { status: 429 }) : null;
    await withInvestec([tokenRoute(), limited], async () => {
      const err = await p.fetchBalances(context(CREDS)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('rate-limited');
    });
  });
});

describe('InvestecProvider.fetchTransactions', () => {
  const routes = (rows: ReturnType<typeof transaction>[], totalPages = 1) => [
    tokenRoute(),
    accountsRoute([account('A1', 'Private Bank Account')]),
    balanceRoute({ A1: { current: 10, currency: 'ZAR' } }),
    transactionsRoute({ A1: rows }, totalPages),
  ];

  test('signs CREDIT in and DEBIT out, in the account currency, dated at the end of the posting day', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(
      routes([
        transaction('87446202607140010600', 'DEBIT', 237.29, '2026-07-14'),
        transaction('87446202607150010601', 'CREDIT', 5000, '2026-07-15'),
      ]),
      async () => {
        const events = await p.fetchTransactions(context(CREDS));
        expect(
          events.map((e) => [
            e.externalId,
            e.kind,
            e.primary.quantity,
            e.primary.tokenIdentity.symbol,
            e.occurredAt.toISOString(),
          ])
        ).toEqual([
          ['87446202607140010600', 'withdraw', '-237.29', 'ZAR', '2026-07-14T23:59:59.000Z'],
          ['87446202607150010601', 'deposit', '5000', 'ZAR', '2026-07-15T23:59:59.000Z'],
        ]);
        expect(events[0]?.counterparty).toBe('CORNER CAFE CAPE TOWN ZA');
      }
    );
  });

  test('keeps the card number out of what it stores', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(routes([transaction('u1', 'DEBIT', 1, '2026-07-14')]), async () => {
      const [event] = await p.fetchTransactions(context(CREDS));
      expect(JSON.stringify(event?.rawPayload)).not.toContain('400000xxxxxx0001');
      expect(JSON.stringify(event?.rawPayload)).toContain('u1');
    });
  });

  test('skips a row that is not posted', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(
      routes([
        transaction('u1', 'DEBIT', 1, '2026-07-14', { status: 'PENDING' }),
        transaction('u2', 'DEBIT', 2, '2026-07-14'),
      ]),
      async () => {
        expect((await p.fetchTransactions(context(CREDS))).map((e) => e.externalId)).toEqual([
          'u2',
        ]);
      }
    );
  });

  test('asks for the range from `since` to `until`, by date', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    await withInvestec(routes([]), async (calls) => {
      await p.fetchTransactions(
        context(CREDS, {
          since: new Date('2026-09-01T10:00:00Z'),
          until: new Date('2026-10-01T00:00:00Z'),
        })
      );
      const path = calls.find((c) => c.path.includes('/transactions'))?.path ?? '';
      expect(path).toContain('fromDate=2026-09-01');
      expect(path).toContain('toDate=2026-10-01');
    });
  });

  // With no `fromDate`, Investec returns 180 days: "Will default to today's
  // date, minus 180 days, if not specified" (the API reference, 2026-10-12).
  test('a run with no `since` asks for 180 days and declares that horizon', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    expect(p.transactionHistoryHorizonMs).toBe(180 * 24 * 60 * 60 * 1000);
    await withInvestec(routes([]), async (calls) => {
      await p.fetchTransactions(context(CREDS));
      const path = calls.find((c) => c.path.includes('/transactions'))?.path ?? '';
      const from = /fromDate=(\d{4}-\d{2}-\d{2})/.exec(path)?.[1];
      const expected = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      expect(from).toBe(expected);
    });
  });

  // Investec has no page parameter, so rows past the first page cannot be
  // asked for.
  test('a response with more than one page retracts the completeness claim', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    const retractions: string[] = [];
    await withInvestec(routes([transaction('u1', 'DEBIT', 1, '2026-07-14')], 3), async () => {
      await p.fetchTransactions(
        context(CREDS, {
          retractHistoryClaim: (reason: NoticeInput) => {
            retractions.push(toJobNotice(reason).text);
          },
        })
      );
    });
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('A1');
  });

  test('CONTROL: a single-page response retracts nothing', async () => {
    const p = new InvestecProvider(passthroughLimiter());
    const retractions: string[] = [];
    await withInvestec(routes([transaction('u1', 'DEBIT', 1, '2026-07-14')]), async () => {
      await p.fetchTransactions(
        context(CREDS, {
          retractHistoryClaim: (reason: NoticeInput) => {
            retractions.push(toJobNotice(reason).text);
          },
        })
      );
    });
    expect(retractions).toHaveLength(0);
  });
});

const LIVE = process.env.SCANI_LIVE === '1';
const live = LIVE ? describe : describe.skip;

/**
 * Against Investec's real sandbox. Needs no account: Investec publishes the
 * sandbox client id, secret and API key on its API reference page
 * (developer.investec.com/api-reference, "Sandbox credentials"); pass them as
 * `INVESTEC_SANDBOX_CLIENT_ID`, `INVESTEC_SANDBOX_CLIENT_SECRET` and
 * `INVESTEC_SANDBOX_API_KEY`. The sandbox key carries every scope, so the
 * connect step must refuse it while the reads still work.
 */
live('InvestecProvider live (sandbox)', () => {
  const baseUrl =
    process.env.SCANI_TESTNET_INVESTEC_BASE_URL ?? 'https://openapisandbox.investec.com';
  const creds = {
    clientId: process.env.INVESTEC_SANDBOX_CLIENT_ID ?? '',
    clientSecret: process.env.INVESTEC_SANDBOX_CLIENT_SECRET ?? '',
    apiKey: process.env.INVESTEC_SANDBOX_API_KEY ?? '',
  };

  test('refuses the all-scope sandbox key, then reads balances and transactions', async () => {
    const p = new InvestecProvider(passthroughLimiter(), baseUrl);
    const result = await p.validateCredentials(creds, 'investec');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('can move money');

    const balances = await p.fetchBalances(context(creds));
    expect(balances.length).toBeGreaterThan(0);
    const events = await p.fetchTransactions(context(creds));
    expect(events.length).toBeGreaterThan(0);
  }, 60_000);
});
