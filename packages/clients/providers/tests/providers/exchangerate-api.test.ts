import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import { type OutflowRateLimiter, OutflowRateLimiterRegistry } from '@scani/rate-limiter';
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import { freshExchangeRateApiClient } from '../../../../business/domain/test/helpers/exchangerate-api';
import { rateBetween, rateTable } from '../../src/providers/exchangerate-api/client';

// Each test installs a client and a limiter registry of its own in the
// process-global container; put back whatever this file changes (SC-448).
restoreContainerAfterAll();

const USD_TABLE_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

/** Invented: units of each currency per one USD. */
const USD_TABLE = { USD: 1, EUR: 0.8, GBP: 0.64, CAD: 1.25, RUB: 97.25, JPY: 160.25 };

const NINE = new Date('2026-01-10T09:00:00Z');
const minutesAfterNine = (minutes: number) => new Date(NINE.getTime() + minutes * 60_000);

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;

afterEach(() => {
  mock.restore();
  globalThis.fetch = realFetch;
  setSystemTime();
});

type Answer = () => Response;

const usdTable =
  (rates: Record<string, unknown> = USD_TABLE): Answer =>
  () =>
    Response.json({ base: 'USD', rates });
const refusal: Answer = () => new Response('busy', { status: 503 });

/**
 * Answers each request with the next of `answers`, and with the last of them
 * from then on. Records every request's URL and abort signal.
 */
function upstream(...answers: Answer[]) {
  const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const answer = answers[Math.min(requests.length, answers.length - 1)];
    requests.push({ url: String(input), signal: init?.signal });
    if (!answer) throw new Error('test bug: an upstream with no answer');
    return answer();
  }) as unknown as typeof fetch;
  return requests;
}

/** A fresh client, the limiter the registry handed out for it, and what the registry was asked. */
function clientAndItsLimiter() {
  const registry = new OutflowRateLimiterRegistry();
  const handedOut = spyOn(registry, 'get');
  const client = freshExchangeRateApiClient(registry);
  const limiter = handedOut.mock.results[0]?.value as OutflowRateLimiter | undefined;
  if (!limiter) throw new Error('no limiter was taken from the registry');
  return { client, limiter, askedFor: handedOut.mock.calls.map(([config]) => config) };
}

describe('the one client of exchangerate-api', () => {
  test('a success is kept for sixty minutes, and no longer', async () => {
    const requests = upstream(usdTable());
    setSystemTime(NINE);
    const client = freshExchangeRateApiClient();

    const first = await client.fetchUsdRates();
    setSystemTime(minutesAfterNine(11));
    await client.fetchUsdRates();
    setSystemTime(new Date(minutesAfterNine(60).getTime() - 1));
    const stillKept = await client.fetchUsdRates();
    expect(requests.map((request) => request.url)).toEqual([USD_TABLE_URL]);
    expect(first?.fetchedAt).toEqual(NINE);
    expect(stillKept).toBe(first);

    setSystemTime(minutesAfterNine(60));
    const refreshed = await client.fetchUsdRates();
    expect(requests.map((request) => request.url)).toEqual([USD_TABLE_URL, USD_TABLE_URL]);
    expect(refreshed?.fetchedAt).toEqual(minutesAfterNine(60));
  });

  test('callers that ask while the table is in flight share one request', async () => {
    const requests = upstream(usdTable());
    const client = freshExchangeRateApiClient();

    const tables = await Promise.all([
      client.fetchUsdRates(),
      client.fetchUsdRates(),
      client.fetchUsdRates(),
    ]);

    expect(requests.length).toBe(1);
    expect(tables.map((table) => table?.rates.EUR)).toEqual(['0.8', '0.8', '0.8']);
  });

  test('a failed request is not cached', async () => {
    const requests = upstream(
      () => {
        throw new Error('socket closed');
      },
      refusal,
      () => Response.json({ result: 'error' }),
      usdTable()
    );
    const client = freshExchangeRateApiClient();

    expect(await client.fetchUsdRates()).toBeNull();
    expect(await client.fetchUsdRates()).toBeNull();
    expect(await client.fetchUsdRates()).toBeNull();
    expect((await client.fetchUsdRates())?.rates.EUR).toBe('0.8');
    expect(requests.length).toBe(4);
  });

  test('every request takes its slot from the registry, under the exchangerate-api namespace', async () => {
    const requests = upstream(usdTable());
    const { client, limiter, askedFor } = clientAndItsLimiter();
    const slots = spyOn(limiter, 'execute');

    await client.fetchUsdRates();

    expect(askedFor.map((config) => config.namespace)).toEqual(['exchangerate-api']);
    expect(slots).toHaveBeenCalledTimes(1);
    expect(requests.length).toBe(1);
  });

  test('the vendor’s budget is ten requests in sixty seconds', async () => {
    const requests = upstream(refusal);
    setSystemTime(NINE);
    const { client, limiter } = clientAndItsLimiter();

    // A refusal is not kept, so each ask is a request and takes a slot.
    for (let ask = 0; ask < 10; ask++) await client.fetchUsdRates();

    expect(requests.length).toBe(10);
    expect(await limiter.tryConsume()).toEqual({ ok: false, retryAfterMs: 60_000 });
  });

  test('the request carries the ask’s abort signal', async () => {
    const bound = spyOn(AbortSignal, 'timeout');
    const requests = upstream(usdTable());
    const { client, limiter } = clientAndItsLimiter();
    const slots = spyOn(limiter, 'execute');

    await client.fetchUsdRates();

    expect(bound.mock.calls).toEqual([[8_000]]);
    const signal = bound.mock.results[0]?.value as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]?.signal).toBe(signal);
    // The wait for a slot is under the same bound as the request.
    expect(slots.mock.calls[0]?.[2]).toBe(signal);
  });

  test('an ask that cannot get a slot gives null and sends nothing', async () => {
    // The ask's own bound, cut short so the test does not wait it out.
    const bounds: number[] = [];
    spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      bounds.push(ms);
      return realTimeout.call(AbortSignal, 50);
    });
    const requests = upstream(refusal);
    const client = freshExchangeRateApiClient();
    // A refusal is not kept, so each ask is a request and takes one of the ten slots.
    for (let ask = 0; ask < 10; ask++) await client.fetchUsdRates();
    expect(requests.length).toBe(10);

    const stillWaiting = 'still waiting for a slot';
    const eleventh = Promise.all([client.fetchUsdRates(), client.fetchUsdRates()]);
    const outcome = await Promise.race([eleventh, Bun.sleep(1_000).then(() => stillWaiting)]);

    expect(outcome).toEqual([null, null]);
    expect(requests.length).toBe(10);
    expect(new Set(bounds)).toEqual(new Set([8_000]));
  });

  test('a table with no usable rate is not kept', async () => {
    const requests = upstream(
      usdTable({}),
      usdTable({ USD: 1 }),
      usdTable({ USD: 1, EUR: 0, GBP: '0.64' }),
      usdTable()
    );
    const client = freshExchangeRateApiClient();

    expect(await client.fetchUsdRates()).toBeNull();
    expect(await client.fetchUsdRates()).toBeNull();
    expect(await client.fetchUsdRates()).toBeNull();
    expect((await client.fetchUsdRates())?.rates.EUR).toBe('0.8');
    expect(requests.length).toBe(4);
  });

  test('a rate that is not a number is skipped', async () => {
    // Written out as text: 1e999 is a number too large to be finite.
    upstream(
      () =>
        new Response(
          '{"base":"USD","rates":{"USD":1,"EUR":0.8,"TXT":"2.5","LST":[2.5],"NIL":null,"ZRO":0,"NEG":-2,"BIG":1e999}}'
        )
    );

    const table = await freshExchangeRateApiClient().fetchUsdRates();

    expect(table?.rates).toEqual({ USD: '1', EUR: '0.8' });
  });

  test('a table in another base is refused', async () => {
    const requests = upstream(
      () => Response.json({ base: 'EUR', rates: USD_TABLE }),
      () => Response.json({ rates: USD_TABLE }),
      usdTable()
    );
    const client = freshExchangeRateApiClient();

    expect(await client.fetchUsdRates()).toBeNull();
    expect(await client.fetchUsdRates()).toBeNull();
    expect((await client.fetchUsdRates())?.rates.EUR).toBe('0.8');
    expect(requests.length).toBe(3);
  });

  test('RUB against USD keeps its digits', async () => {
    upstream(usdTable());

    const table = await freshExchangeRateApiClient().fetchUsdRates();

    // 1 / 97.25 at 28 significant digits. Asked by its own base, the vendor answers 0.01.
    expect(table && rateBetween(table.rates, 'RUB', 'USD')).toBe('0.01028277634961439588688946015');
  });

  test('a cross pair goes through USD', async () => {
    const requests = upstream(usdTable());

    const table = await freshExchangeRateApiClient().fetchUsdRates();

    // EUR in GBP is rates.GBP / rates.EUR: 0.64 / 0.8.
    expect(table && rateBetween(table.rates, 'EUR', 'GBP')).toBe('0.8');
    expect(table && rateBetween(table.rates, 'GBP', 'EUR')).toBe('1.25');
    expect(table && rateBetween(table.rates, 'EUR', 'EUR')).toBe('1');
    expect(requests.map((request) => request.url)).toEqual([USD_TABLE_URL]);
  });

  test('a pair is found whatever the case of its symbols', async () => {
    upstream(usdTable());

    const table = await freshExchangeRateApiClient().fetchUsdRates();

    expect(table && rateBetween(table.rates, 'gbp', 'Eur')).toBe('1.25');
  });

  test('a table is read in the base it was asked in', () => {
    // Invented: units of each currency per one EUR.
    const perEur = rateTable({ USD: 1.2, JPY: 150 }, 'EUR');
    if (!perEur) throw new Error('two usable rates make a table');

    // 1.2 / 150. Read as a USD table, the same rates give 1 / 150.
    expect(rateBetween(perEur, 'JPY', 'USD')).toBe('0.008');
    expect(rateBetween(perEur, 'EUR', 'USD')).toBe('1.2');
    expect(rateBetween(perEur, 'USD', 'EUR')).toBe('0.8333333333333333333333333333');
    // The base is 1 whatever the vendor lists for it.
    expect(rateTable({ EUR: 3, USD: 1.2 }, 'EUR')?.EUR).toBe('1');
  });

  // CONTROL: what must stay null however the table is read.
  test('a currency missing from the table, or a zero or negative rate, gives null', async () => {
    upstream(usdTable({ USD: 1, EUR: 0.8, ZRO: 0, NEG: -2 }));

    const table = await freshExchangeRateApiClient().fetchUsdRates();
    if (!table) throw new Error('the upstream answered, so there is a table');

    for (const symbol of ['RUB', 'ZRO', 'NEG']) {
      expect(rateBetween(table.rates, symbol, 'USD')).toBeNull();
      expect(rateBetween(table.rates, 'USD', symbol)).toBeNull();
    }
    // The same table still answers a pair it does hold.
    expect(rateBetween(table.rates, 'EUR', 'USD')).toBe('1.25');
  });
});
