import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../src/core/errors';
import { type NoticeInput, type TransactionFetchContext, toJobNotice } from '../../src/core/types';
import { BunqProvider } from '../../src/providers/bunq';
import { bunqManifest } from '../../src/providers/bunq/manifest';

/**
 * bunq, read-only, for self-hosted Scani only (SC-1729).
 *
 * The stubbed responses below are the shapes bunq's SANDBOX returned on
 * 2026-10-11 (`public-api.sandbox.bunq.com`), trimmed to the fields the
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
async function withBunq<T>(routes: Route[], run: (calls: Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Call = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    throw new Error(`unexpected bunq call: ${call.method} ${call.path}`);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const INSTALLATION_TOKEN = 'installation-token';
const SESSION_TOKEN = 'session-token';
const USER_ID = 3775079;

function installationRoute(call: Call): Response | null {
  if (call.method !== 'POST' || call.path !== '/v1/installation') return null;
  return json({
    Response: [
      { Id: { id: 10385922 } },
      { Token: { id: 1, token: INSTALLATION_TOKEN } },
      { ServerPublicKey: { server_public_key: '-----BEGIN PUBLIC KEY-----\n…' } },
    ],
  });
}

function deviceRoute(call: Call): Response | null {
  if (call.method !== 'POST' || call.path !== '/v1/device-server') return null;
  return json({ Response: [{ Id: { id: 5168457 } }] });
}

function sessionRoute(call: Call): Response | null {
  if (call.method !== 'POST' || call.path !== '/v1/session-server') return null;
  return json({
    Response: [
      { Id: { id: 31997903 } },
      { Token: { id: 31997903, token: SESSION_TOKEN } },
      { UserPerson: { id: USER_ID, display_name: 'P. Tangere', session_timeout: 604800 } },
    ],
  });
}

function account(kind: string, id: number, currency: string, value: string, status = 'ACTIVE') {
  return {
    [kind]: {
      id,
      currency,
      balance: { currency, value },
      status,
      description: `${kind} ${id}`,
    },
  };
}

function accountsRoute(accounts: unknown[]): Route {
  return (call) =>
    call.method === 'GET' && call.path.startsWith(`/v1/user/${USER_ID}/monetary-account?`)
      ? json({
          Response: accounts,
          Pagination: { future_url: null, newer_url: null, older_url: null },
        })
      : null;
}

function payment(id: number, created: string, value: string, description = `payment ${id}`) {
  return {
    Payment: {
      id,
      created,
      monetary_account_id: 3790446,
      amount: { currency: 'EUR', value },
      description,
      type: 'BUNQ',
      sub_type: 'PAYMENT',
      alias: { iban: 'NL00BUNQ0000000001', display_name: 'P. Tangere' },
      counterparty_alias: { iban: 'NL00BUNQ0000000002', display_name: 'Sugar Daddy' },
    },
  };
}

/** Credentials as the connect step stores them: the key plus its installation. */
function storedCredentials() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    apiKey: 'sandbox-api-key',
    installationToken: INSTALLATION_TOKEN,
    privateKeyPem: privateKey,
  };
}

function context(creds: Record<string, string>, extra: Partial<TransactionFetchContext> = {}) {
  return {
    institutionCode: 'bunq',
    baseCurrency: { id: 'eur', symbol: 'EUR' },
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => creds,
    ...extra,
  } as unknown as TransactionFetchContext;
}

describe('the bunq manifest', () => {
  test('asks for the personal API key and nothing else', () => {
    expect(bunqManifest.credentialFields.map((f) => f.name)).toEqual(['apiKey']);
    expect(bunqManifest.credentialFields[0]?.sensitive).toBe(true);
  });

  test('is marked self-hosted only, because bunq allows the key only in your own software', () => {
    expect(bunqManifest.selfHostedOnly).toBe(true);
  });

  test('imports bunq accounts as bank accounts, not crypto', () => {
    expect(bunqManifest.defaultAccountTypeCode).toBe('checking');
  });

  // bunq offers no read-only key: its keys "grant broad permissions", so the
  // connect screen has to say the key can move money (SC-1729).
  test('declares that its key can move money', () => {
    expect(bunqManifest.credentialCanMoveMoney).toBe(true);
  });

  // The hosted product cannot connect bunq, so it points at the statement bunq
  // exports. bunq's help lists "PDF, CSV or MT940"; Scani reads the last two.
  // bunq offers no CAMT.053, so naming it would send people looking for it.
  test('names the statement formats bunq exports and Scani imports', () => {
    expect(bunqManifest.statementExportFormats).toEqual(['MT940', 'CSV']);
  });
});

/**
 * Read-only is a property of THIS code, since the key itself is not read-only.
 * Two guards: what a full run sends, and what the source can send.
 */
describe('BunqProvider never writes', () => {
  const AUTH_POSTS = ['/v1/installation', '/v1/device-server', '/v1/session-server'];

  test('a connect, a balance read and a transaction read POST only to the three auth endpoints', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const paymentsRoute = (call: Call) =>
      call.path.includes('/payment')
        ? json({ Response: [payment(1, '2026-10-01 10:00:00.000000', '-1.00')], Pagination: {} })
        : null;
    await withBunq(
      [
        installationRoute,
        deviceRoute,
        sessionRoute,
        accountsRoute([account('MonetaryAccountBank', 1, 'EUR', '10.00')]),
        paymentsRoute,
      ],
      async (calls) => {
        const connected = await p.validateCredentials({ apiKey: 'k' }, 'bunq');
        const creds = connected.credentials as Record<string, string>;
        await p.fetchBalances(context(creds));
        await p.fetchTransactions(context(creds));
        const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
        expect(writes.every((w) => AUTH_POSTS.some((path) => w === `POST ${path}`))).toBe(true);
        expect(calls.some((c) => c.method === 'GET')).toBe(true);
      }
    );
  });

  test('the source names no other POST, and no PUT or DELETE at all', () => {
    const source = readFileSync(
      new URL('../../src/providers/bunq/index.ts', import.meta.url),
      'utf8'
    );
    const posted = [...source.matchAll(/this\.post\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((path) => AUTH_POSTS.includes(path ?? ''))).toBe(true);
    expect(source).not.toMatch(/'(PUT|DELETE|PATCH)'/);
  });

  // A wildcard (`permitted_ips: ["*"]`) would let the key work from anywhere.
  // Left out, bunq ties the key to the server that registered it.
  test('registers the device with no IP wildcard', async () => {
    const p = new BunqProvider(passthroughLimiter());
    await withBunq(
      [installationRoute, deviceRoute, sessionRoute, accountsRoute([])],
      async (calls) => {
        await p.validateCredentials({ apiKey: 'k' }, 'bunq');
        const device = calls.find((c) => c.path === '/v1/device-server');
        expect(Object.keys(JSON.parse(device?.body ?? '{}')).sort()).toEqual([
          'description',
          'secret',
        ]);
      }
    );
  });
});

describe('BunqProvider.validateCredentials', () => {
  test('registers the key once and returns the installation for the connect step to store', async () => {
    const p = new BunqProvider(passthroughLimiter());
    await withBunq(
      [
        installationRoute,
        deviceRoute,
        sessionRoute,
        accountsRoute([account('MonetaryAccountBank', 1, 'EUR', '10.00')]),
      ],
      async (calls) => {
        const result = await p.validateCredentials({ apiKey: 'sandbox-api-key' }, 'bunq');
        expect(result.valid).toBe(true);
        expect(result.credentials?.apiKey).toBe('sandbox-api-key');
        expect(result.credentials?.installationToken).toBe(INSTALLATION_TOKEN);
        expect(String(result.credentials?.privateKeyPem)).toContain('BEGIN PRIVATE KEY');

        expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
          'POST /v1/installation',
          'POST /v1/device-server',
          'POST /v1/session-server',
          `GET /v1/user/${USER_ID}/monetary-account`,
        ]);
        // The device is registered with the key as its secret and the
        // installation token as its authentication.
        const device = calls[1]!;
        expect(JSON.parse(device.body ?? '{}').secret).toBe('sandbox-api-key');
        expect(device.headers['x-bunq-client-authentication']).toBe(INSTALLATION_TOKEN);
        // The read uses the session, never the key.
        expect(calls[3]!.headers['x-bunq-client-authentication']).toBe(SESSION_TOKEN);
      }
    );
  });

  test('signs the session request with the installation key it registered', async () => {
    const p = new BunqProvider(passthroughLimiter());
    await withBunq(
      [installationRoute, deviceRoute, sessionRoute, accountsRoute([])],
      async (calls) => {
        await p.validateCredentials({ apiKey: 'sandbox-api-key' }, 'bunq');
        const publicKey = JSON.parse(calls[0]!.body ?? '{}').client_public_key as string;
        const session = calls[2]!;
        const signature = session.headers['x-bunq-client-signature'];
        expect(signature).toBeTruthy();
        const verified = crypto
          .createVerify('RSA-SHA256')
          .update(session.body ?? '')
          .verify(publicKey, signature!, 'base64');
        expect(verified).toBe(true);
      }
    );
  });

  test("a key bunq rejects is a verdict about the key, in bunq's own words", async () => {
    const p = new BunqProvider(passthroughLimiter());
    const rejected = (call: Call) =>
      call.path === '/v1/device-server'
        ? json(
            {
              Error: [
                {
                  error_description:
                    'User credentials are incorrect. Incorrect API key or IP address.',
                },
              ],
            },
            400
          )
        : null;
    await withBunq([installationRoute, rejected], async () => {
      const result = await p.validateCredentials({ apiKey: 'not-a-real-key' }, 'bunq');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('Incorrect API key or IP address');
    });
  });

  test('CONTROL: an outage is not a verdict — it throws, so the form says it could not check', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const down = (call: Call) => (call.path === '/v1/installation' ? json({}, 503) : null);
    await withBunq([down], async () => {
      await expect(p.validateCredentials({ apiKey: 'k' }, 'bunq')).rejects.toBeInstanceOf(
        ProviderError
      );
    });
  });

  test('a missing key and the wrong institution are refused without asking bunq', async () => {
    const p = new BunqProvider(passthroughLimiter());
    await withBunq([], async (calls) => {
      expect((await p.validateCredentials({}, 'bunq')).valid).toBe(false);
      expect((await p.validateCredentials({ apiKey: 'k' }, 'wise')).valid).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('BunqProvider.fetchBalances', () => {
  test('uses the stored installation: one signed session, then the accounts', async () => {
    const p = new BunqProvider(passthroughLimiter());
    await withBunq(
      [sessionRoute, accountsRoute([account('MonetaryAccountBank', 1, 'EUR', '123.45')])],
      async (calls) => {
        await p.fetchBalances(context(storedCredentials()));
        expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
          'POST /v1/session-server',
          `GET /v1/user/${USER_ID}/monetary-account`,
        ]);
      }
    );
  });

  test('sums every account per currency, across account kinds, and drops empty ones', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const accounts = [
      account('MonetaryAccountBank', 1, 'EUR', '100.10'),
      account('MonetaryAccountSavings', 2, 'EUR', '50.05'),
      account('MonetaryAccountJoint', 3, 'USD', '20.00'),
      account('MonetaryAccountBank', 4, 'GBP', '0.00'),
    ];
    await withBunq([sessionRoute, accountsRoute(accounts)], async () => {
      const holdings = await p.fetchBalances(context(storedCredentials()));
      const byCurrency = Object.fromEntries(holdings.map((h) => [h.externalId, h.balance]));
      expect(byCurrency).toEqual({ EUR: '150.15', USD: '20' });
      expect(holdings.every((h) => h.tokenType === 'fiat')).toBe(true);
    });
  });

  test('a stored credential with no installation asks the user to reconnect, and calls nobody', async () => {
    const p = new BunqProvider(passthroughLimiter());
    await withBunq([], async (calls) => {
      const failure = await p.fetchBalances(context({ apiKey: 'k' })).catch((err) => err);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).kind).toBe('auth-failed');
      expect(calls).toHaveLength(0);
    });
  });

  test('a rate limit is classified as one', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const limited = (call: Call) =>
      call.path === '/v1/session-server'
        ? json({ Error: [{ error_description: 'Too many requests.' }] }, 429)
        : null;
    await withBunq([limited], async () => {
      const failure = await p.fetchBalances(context(storedCredentials())).catch((err) => err);
      expect((failure as ProviderError).kind).toBe('rate-limited');
    });
  });
});

describe('BunqProvider.fetchTransactions', () => {
  const accounts = [account('MonetaryAccountBank', 3790446, 'EUR', '123.45')];
  const paymentsPath = `/v1/user/${USER_ID}/monetary-account/3790446/payment`;

  test('maps signed amounts to deposits and withdrawals, stamped in UTC', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const payments = (call: Call) =>
      call.path.startsWith(paymentsPath)
        ? json({
            Response: [
              payment(2, '2026-10-11 16:41:11.893634', '123.45', 'sc1729 probe'),
              payment(1, '2026-10-10 08:00:00.000000', '-12.30', 'Coffee'),
            ],
            Pagination: { future_url: null, newer_url: null, older_url: null },
          })
        : null;
    await withBunq([sessionRoute, accountsRoute(accounts), payments], async () => {
      const events = await p.fetchTransactions(context(storedCredentials()));
      expect(events.map((e) => [e.externalId, e.kind, e.primary.quantity])).toEqual([
        ['2', 'deposit', '123.45'],
        ['1', 'withdraw', '-12.3'],
      ]);
      expect(events[0]!.occurredAt.toISOString()).toBe('2026-10-11T16:41:11.893Z');
      expect(events[0]!.counterparty).toBe('Sugar Daddy');
      expect(events[0]!.description).toBe('sc1729 probe');
    });
  });

  test('walks older pages until it passes `since`, and asks for nothing older', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const older = `${paymentsPath}?count=200&older_id=20`;
    const payments = (call: Call) => {
      if (!call.path.startsWith(paymentsPath)) return null;
      if (call.path === older) {
        return json({
          Response: [
            payment(19, '2026-09-02 10:00:00.000000', '-1.00'),
            payment(18, '2026-08-20 10:00:00.000000', '-2.00'),
          ],
          Pagination: { older_url: `${paymentsPath}?count=200&older_id=18` },
        });
      }
      return json({
        Response: [payment(20, '2026-10-01 10:00:00.000000', '5.00')],
        Pagination: { older_url: older },
      });
    };
    await withBunq([sessionRoute, accountsRoute(accounts), payments], async (calls) => {
      const events = await p.fetchTransactions(
        context(storedCredentials(), { since: new Date('2026-09-01T00:00:00Z') })
      );
      expect(events.map((e) => e.externalId)).toEqual(['20', '19']);
      // Page 2 already reached past `since`, so page 3 is never asked for.
      expect(calls.filter((c) => c.path.startsWith(paymentsPath))).toHaveLength(2);
    });
  });

  test('a walk stopped by its page cap retracts the completeness claim', async () => {
    const p = new BunqProvider(passthroughLimiter());
    let n = 1_000_000;
    const endless = (call: Call) =>
      call.path.startsWith(paymentsPath)
        ? json({
            Response: [payment(n--, '2026-10-01 10:00:00.000000', '-1.00')],
            Pagination: { older_url: `${paymentsPath}?count=200&older_id=${n}` },
          })
        : null;
    const retractions: string[] = [];
    await withBunq([sessionRoute, accountsRoute(accounts), endless], async () => {
      await p.fetchTransactions(
        context(storedCredentials(), {
          retractHistoryClaim: (reason: NoticeInput) => {
            retractions.push(toJobNotice(reason).text);
          },
        })
      );
    });
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('3790446');
  });

  test('CONTROL: a walk that runs out of rows retracts nothing', async () => {
    const p = new BunqProvider(passthroughLimiter());
    const payments = (call: Call) =>
      call.path.startsWith(paymentsPath)
        ? json({ Response: [payment(1, '2026-10-01 10:00:00.000000', '-1.00')], Pagination: {} })
        : null;
    const retractions: string[] = [];
    await withBunq([sessionRoute, accountsRoute(accounts), payments], async () => {
      await p.fetchTransactions(
        context(storedCredentials(), {
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
 * Against bunq's real sandbox. Needs no account: bunq creates a sandbox user
 * and its API key on request (`POST /v1/sandbox-user-person`).
 */
live('BunqProvider live (sandbox)', () => {
  const baseUrl = process.env.SCANI_TESTNET_BUNQ_BASE_URL ?? 'https://public-api.sandbox.bunq.com';

  test('connect, then read balances and transactions', async () => {
    const created = await fetch(`${baseUrl}/v1/sandbox-user-person`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'scani-sc1729-test',
        'X-Bunq-Client-Request-Id': crypto.randomUUID(),
        'X-Bunq-Language': 'en_US',
        'X-Bunq-Region': 'nl_NL',
        'X-Bunq-Geolocation': '0 0 0 0 000',
      },
      body: '{}',
    });
    const body = (await created.json()) as { Response?: Array<{ ApiKey?: { api_key: string } }> };
    const apiKey = body.Response?.find((r) => r.ApiKey)?.ApiKey?.api_key;
    if (!apiKey) throw new Error(`sandbox user not created (HTTP ${created.status})`);

    const p = new BunqProvider(passthroughLimiter(), baseUrl);
    const result = await p.validateCredentials({ apiKey }, 'bunq');
    expect(result.valid).toBe(true);
    const creds = result.credentials as Record<string, string>;

    const balances = await p.fetchBalances(context(creds));
    expect(Array.isArray(balances)).toBe(true);
    const events = await p.fetchTransactions(context(creds));
    expect(Array.isArray(events)).toBe(true);
  }, 60_000);
});
