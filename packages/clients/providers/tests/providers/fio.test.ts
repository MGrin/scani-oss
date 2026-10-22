import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../src/core/errors';
import type { TransactionFetchContext } from '../../src/core/types';
import { FioProvider } from '../../src/providers/fio';
import { fioManifest } from '../../src/providers/fio/manifest';

/**
 * Fio banka, read-only, for self-hosted Scani only (SC-1732).
 *
 * Fio has no sandbox for its token API ("Pro účely reálného testování při
 * vývoji je nutné mít zřízen skutečný účet"), so the stubbed responses below
 * follow the JSON in Fio's API document (API Bankovnictví v1.9, 16. 10. 2025),
 * trimmed to the columns the connector reads. The document's example writes a
 * date as epoch milliseconds; the live API writes "2026-10-01+0200". Both are
 * covered. The live block at the end needs a real token in `FIO_TOKEN`.
 */

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

interface Call {
  method: string;
  path: string;
}

type Route = (call: Call) => Response | null;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

async function withFio<T>(routes: Route[], run: (calls: Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    throw new Error(`unexpected Fio call: ${call.method} ${call.path}`);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const TOKEN = 'token-for-one-account';
const PERIODS =
  /^\/v1\/rest\/periods\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/transactions\.json$/;

const col = (id: number, name: string, value: unknown) =>
  value === null ? null : { value, name, id };

function movement(
  id: number,
  date: string | number,
  amount: number,
  extra: { counterparty?: string; message?: string; type?: string; currency?: string } = {}
) {
  return {
    column22: col(22, 'ID pohybu', id),
    column0: col(0, 'Datum', date),
    column1: col(1, 'Objem', amount),
    column14: col(14, 'Měna', extra.currency ?? 'CZK'),
    column2: col(2, 'Protiúčet', '2900233333'),
    column10: col(10, 'Název protiúčtu', extra.counterparty ?? null),
    column3: col(3, 'Kód banky', '2010'),
    column16: col(16, 'Zpráva pro příjemce', extra.message ?? null),
    column8: col(8, 'Typ', extra.type ?? 'Příjem převodem uvnitř banky'),
    column25: col(25, 'Komentář', null),
  };
}

function statement(
  movements: ReturnType<typeof movement>[],
  info: { closingBalance?: number; currency?: string } = {}
) {
  return {
    accountStatement: {
      info: {
        accountId: '2400222222',
        bankId: '2010',
        currency: info.currency ?? 'CZK',
        iban: 'CZ7920100000002400222222',
        bic: 'FIOBCZPPXXX',
        openingBalance: 195.0,
        closingBalance: info.closingBalance ?? 195.01,
        dateStart: '2026-07-04+0200',
        dateEnd: '2026-10-01+0200',
        idFrom: 1148734530,
        idTo: 1149190193,
        idLastDownload: null,
      },
      transactionList: { transaction: movements },
    },
  };
}

function periodsRoute(body: unknown): Route {
  return (call) => (call.method === 'GET' && PERIODS.test(call.path) ? json(body) : null);
}

function context(extra: Partial<TransactionFetchContext> = {}) {
  return {
    institutionCode: 'fio',
    baseCurrency: { id: 'czk', symbol: 'CZK' },
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({ token: TOKEN }),
    ...extra,
  } as unknown as TransactionFetchContext;
}

describe('the Fio manifest', () => {
  test('asks for the API token and nothing else', () => {
    expect(fioManifest.credentialFields.map((f) => f.name)).toEqual(['token']);
    expect(fioManifest.credentialFields[0]?.sensitive).toBe(true);
  });

  test('is marked self-hosted only', () => {
    expect(fioManifest.selfHostedOnly).toBe(true);
  });

  // A token may enter payment orders but not authorise them: "zadávat pokyny
  // k úhradě (ne však takové pokyny autorizovat)" (VSP IB čl. XIII odst. 1).
  test('declares that its token cannot move money', () => {
    expect(fioManifest.credentialCanMoveMoney).toBe(false);
  });

  // "Výpis z účtu je možné … vygenerovat ve formátech *.csv a *.gpc" (Fio's
  // FAQ). Scani imports CSV and not GPC.
  test('names the statement format the hosted notice points to', () => {
    expect(fioManifest.statementExportFormats).toEqual(['CSV']);
  });

  // "nelze založit token bez doby platnosti nebo platnosti delší jak 180 dní"
  // (API document, chapter 2): every token expires (SC-1733).
  test('declares that its token lasts at most 180 days', () => {
    expect(fioManifest.credentialLifetimeDays).toBe(180);
  });

  // Fio calls it a token; the connect page uses the provider's own noun.
  test('names its credential a token', () => {
    expect(fioManifest.credentialNoun).toBe('token');
  });

  test('asks for the read-only permission in its steps', () => {
    expect(fioManifest.instructions.steps.join(' ')).toContain('Sledování účtu');
  });
});

describe('FioProvider never writes', () => {
  test('a connect, a balance read and a transaction read only GET statements', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([periodsRoute(statement([movement(1, '2026-10-01+0200', 1)]))], async (calls) => {
      await p.validateCredentials({ token: TOKEN }, 'fio');
      await p.fetchBalances(context());
      await p.fetchTransactions(context());
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.method === 'GET' && PERIODS.test(c.path))).toBe(true);
    });
  });

  // `/last/` and `set-last-*` move a bookmark on Fio's side; import uploads
  // orders. None of them may be named.
  test('the source names no import, bookmark or `last` endpoint', () => {
    const source = readFileSync(
      new URL('../../src/providers/fio/index.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/\/import|set-last|\/last\/|'POST'|'PUT'|'DELETE'/);
  });
});

describe('FioProvider.validateCredentials', () => {
  test('reads today’s statement with the token', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([periodsRoute(statement([]))], async (calls) => {
      expect((await p.validateCredentials({ token: TOKEN }, 'fio')).valid).toBe(true);
      const match = PERIODS.exec(calls[0]?.path ?? '');
      expect(match?.[1]).toBe(TOKEN);
      expect(match?.[2]).toBe(match?.[3]);
    });
  });

  // Fio documents HTTP 500 as "neexistující nebo neaktivní token" (a token
  // that does not exist or is not active).
  test('a token Fio does not know is refused, in plain words', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([() => new Response('', { status: 500 })], async () => {
      const result = await p.validateCredentials({ token: TOKEN }, 'fio');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('expired or not active');
    });
  });

  test('CONTROL: a token used in the last 30 seconds is not a verdict — it throws', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([() => new Response('', { status: 409 })], async () => {
      const err = await p.validateCredentials({ token: TOKEN }, 'fio').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('rate-limited');
    });
  });

  test('a missing token and the wrong institution are refused without asking Fio', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([], async (calls) => {
      expect((await p.validateCredentials({}, 'fio')).valid).toBe(false);
      expect((await p.validateCredentials({ token: TOKEN }, 'bunq')).valid).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('FioProvider.fetchBalances', () => {
  test('reports the closing balance in the account currency', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([periodsRoute(statement([], { closingBalance: 12345.67 }))], async () => {
      const holdings = await p.fetchBalances(context());
      expect(holdings.map((h) => [h.externalId, h.balance, h.tokenType])).toEqual([
        ['CZK', '12345.67', 'fiat'],
      ]);
    });
  });

  // Fio allows one call per token per 30 seconds, so a sync's balance read and
  // ledger read share one statement.
  test('a balance read then a transaction read make one call', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([periodsRoute(statement([movement(1, '2026-10-01+0200', 1)]))], async (calls) => {
      await p.fetchBalances(context());
      await p.fetchTransactions(context({ since: new Date(Date.now() - 2 * 86_400_000) }));
      expect(calls).toHaveLength(1);
    });
  });

  test('a sync that hits the 30-second rule is classified as rate-limited', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([() => new Response('', { status: 409 })], async () => {
      const err = await p.fetchBalances(context()).catch((e: unknown) => e);
      expect((err as ProviderError).kind).toBe('rate-limited');
    });
  });

  // Fio's known error states give one meaning for a 500: "Chyba indikuje
  // neexistující nebo neaktivní token" (API document, chapter 8). But one 500
  // can also be an outage, and since SC-1728 an `auth-failed` key is not used
  // again until replaced. So a sync's 500 is only a SUSPECT: retried, and
  // confirmed by the sync before the account asks for a new token (SC-1733).
  test('a 500 during a sync is retried, flagged as a suspect token', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([() => new Response('', { status: 500 })], async () => {
      const err = await p.fetchBalances(context()).catch((e: unknown) => e);
      expect((err as ProviderError).kind).toBe('retryable');
      expect((err as ProviderError).suspectCredential).toBe(true);
      expect((err as ProviderError).message).toContain('expired or been turned off');
    });
  });

  test('a 500 during a transaction read is the same suspect', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([() => new Response('', { status: 500 })], async () => {
      const err = await p
        .fetchTransactions(context({ since: new Date(Date.now() - 2 * 86_400_000) }))
        .catch((e: unknown) => e);
      expect((err as ProviderError).kind).toBe('retryable');
      expect((err as ProviderError).suspectCredential).toBe(true);
    });
  });

  test('CONTROL: a 503 during a sync is an outage, and suspects nothing', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([() => new Response('', { status: 503 })], async () => {
      const err = await p.fetchBalances(context()).catch((e: unknown) => e);
      expect((err as ProviderError).kind).toBe('retryable');
      expect((err as ProviderError).suspectCredential).toBeFalsy();
    });
  });
});

describe('FioProvider.fetchTransactions', () => {
  test('keeps Fio’s sign, currency and movement id, dated at the end of the day', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio(
      [
        periodsRoute(
          statement([
            movement(1148734530, '2026-09-30+0200', 1500, { counterparty: 'Pavel, Novák' }),
            movement(1148734781, '2026-10-01+0200', -230.5, { message: 'Nájem' }),
          ])
        ),
      ],
      async () => {
        const events = await p.fetchTransactions(context());
        expect(
          events.map((e) => [
            e.externalId,
            e.kind,
            e.primary.quantity,
            e.primary.tokenIdentity.symbol,
            e.occurredAt.toISOString(),
          ])
        ).toEqual([
          ['1148734530', 'deposit', '1500', 'CZK', '2026-09-30T23:59:59.000Z'],
          ['1148734781', 'withdraw', '-230.5', 'CZK', '2026-10-01T23:59:59.000Z'],
        ]);
        expect(events[0]?.counterparty).toBe('Pavel, Novák');
        expect(events[1]?.description).toBe('Nájem');
      }
    );
  });

  // 1340661600000 is 2012-06-25T22:00Z, which is 26 June in Prague: the
  // document's own example reads "pohyby v období od 26. 6. 2012".
  test('reads the document’s epoch-millisecond date as the Prague day', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([periodsRoute(statement([movement(1, 1340661600000, 1)]))], async () => {
      const [event] = await p.fetchTransactions(
        context({ since: new Date('2012-06-01T00:00:00Z') })
      );
      expect(event?.occurredAt.toISOString()).toBe('2012-06-26T23:59:59.000Z');
    });
  });

  test('asks from `since`, by date, up to today', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio([periodsRoute(statement([]))], async (calls) => {
      await p.fetchTransactions(context({ since: new Date('2026-09-01T10:00:00Z') }));
      const match = PERIODS.exec(calls[0]?.path ?? '');
      expect(match?.[2]).toBe('2026-09-01');
      expect(match?.[3]).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  // "Pohyby starší 90 dnů" need an unlock in internetbanking first, so a run
  // with no `since` reads 90 days and declares that horizon.
  test('a run with no `since` asks for 90 days and declares that horizon', async () => {
    const p = new FioProvider(passthroughLimiter());
    expect(p.transactionHistoryHorizonMs).toBe(90 * 86_400_000);
    await withFio([periodsRoute(statement([]))], async (calls) => {
      await p.fetchTransactions(context());
      const match = PERIODS.exec(calls[0]?.path ?? '');
      expect(match?.[2]).toBe(new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10));
    });
  });

  test('drops rows before `since`', async () => {
    const p = new FioProvider(passthroughLimiter());
    await withFio(
      [
        periodsRoute(
          statement([movement(1, '2026-09-29+0200', 1), movement(2, '2026-10-01+0200', 2)])
        ),
      ],
      async () => {
        const events = await p.fetchTransactions(
          context({ since: new Date('2026-09-30T00:00:00Z') })
        );
        expect(events.map((e) => e.externalId)).toEqual(['2']);
      }
    );
  });
});

const live = process.env.SCANI_LIVE === '1' && process.env.FIO_TOKEN ? describe : describe.skip;

/** Against Fio itself, with a real read-only token. Fio has no sandbox. */
live('FioProvider live', () => {
  test('connect, then read the balance and transactions', async () => {
    const token = process.env.FIO_TOKEN ?? '';
    const p = new FioProvider(passthroughLimiter());
    expect((await p.validateCredentials({ token }, 'fio')).valid).toBe(true);
    const ctx = {
      ...context(),
      resolveCredentials: async () => ({ token }),
    } as unknown as TransactionFetchContext;
    expect(Array.isArray(await p.fetchBalances(ctx))).toBe(true);
  }, 120_000);
});
