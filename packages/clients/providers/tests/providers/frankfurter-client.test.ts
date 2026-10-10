import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import {
  type OutflowLimiterConfig,
  type OutflowRateLimiter,
  OutflowRateLimiterRegistry,
} from '@scani/rate-limiter';
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import {
  CBR_TABLE_URL,
  ECB_TABLE_URL,
  fixing,
  outsideFrankfurterV2,
} from '../../../../business/domain/test/helpers/frankfurter';
import { freshFrankfurterClient } from '../../../../business/domain/test/helpers/frankfurter-client';

// Each test installs a client and a limiter registry of its own in the
// process-global container; put back whatever this file changes (SC-448).
restoreContainerAfterAll();

const DAY = '2024-03-04';
/** Invented: units of each currency per one EUR, as the ECB publishes them. */
const ECB_RATES = { USD: 1.25, GBP: 0.8, JPY: 200.5, ISK: 150 };
/** Invented: units of each currency per one USD, from the CBR's table. */
const CBR_RATES = { RUB: 97.25, EUR: 0.5, KZT: 450.5 };

const NINE = new Date('2026-01-10T09:00:00Z');
const minutesAfterNine = (minutes: number) => new Date(NINE.getTime() + minutes * 60_000);

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;

type Answer = () => Response;
type Asked = { url: string; signal: AbortSignal | null | undefined };

let requests: Asked[] = [];

afterEach(() => {
  mock.restore();
  globalThis.fetch = realFetch;
  setSystemTime();
  // R25-6, R25-7: nothing this file asks leaves Frankfurter v2's named tables.
  expect(outsideFrankfurterV2(requests.map((request) => request.url))).toEqual([]);
  requests = [];
});

const ecbTable =
  (rates: Record<string, unknown> = ECB_RATES, base = 'EUR'): Answer =>
  () =>
    Response.json(fixing(base, DAY, rates));
const cbrTable =
  (rates: Record<string, unknown> = CBR_RATES, base = 'USD'): Answer =>
  () =>
    Response.json(fixing(base, DAY, rates));
const refusal: Answer = () => new Response('busy', { status: 503 });

/**
 * Answers the ECB's table with `ecb` and the CBR's with `cbr`, each request
 * with the next of its answers and the last of them from then on. Records
 * every request's URL and abort signal.
 */
function upstream(answers: { ecb?: Answer[]; cbr?: Answer[] }): Asked[] {
  const seen = { ecb: 0, cbr: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, signal: init?.signal });
    const bank = url.includes('/providers/cbr/') ? 'cbr' : 'ecb';
    const list = answers[bank] ?? [];
    const answer = list[Math.min(seen[bank]++, list.length - 1)];
    return answer ? answer() : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return requests;
}

/**
 * A fresh client over a registry of its own. Records each slot the client
 * takes: the namespace it was taken under and the signal bounding the wait.
 * `limiters` are the registry's own limiters, by namespace.
 */
function clientOverARecordedRegistry() {
  const registry = new OutflowRateLimiterRegistry();
  const realGet = registry.get.bind(registry);
  const slots: Array<{ namespace: string; signal: AbortSignal | undefined }> = [];
  const limiters = new Map<string, OutflowRateLimiter>();
  const handedOut = spyOn(registry, 'get').mockImplementation((config: OutflowLimiterConfig) => {
    const limiter = realGet(config);
    limiters.set(config.namespace, limiter);
    return {
      execute: <T>(fn: () => Promise<T>, key?: string, signal?: AbortSignal) => {
        slots.push({ namespace: config.namespace, signal });
        return limiter.execute(fn, key, signal);
      },
    } as unknown as OutflowRateLimiter;
  });
  const client = freshFrankfurterClient(registry);
  return { client, slots, limiters, handedOut };
}

describe('the one client of Frankfurter: what it asks', () => {
  test('RUB in USD is asked as providers/cbr base=USD and inverted with full digits', async () => {
    upstream({ cbr: [cbrTable()] });

    const rate = await freshFrankfurterClient().latest('RUB', 'USD');

    expect(requests.map((request) => request.url)).toEqual([CBR_TABLE_URL]);
    // 1 / 97.25 at 28 significant digits.
    expect(rate?.price).toBe('0.01028277634961439588688946015');
    expect(rate?.bank).toBe('cbr');
    expect(rate?.source).toBe('frankfurter-cbr');
    expect(rate?.day).toBe(DAY);
  });

  test('an ECB pair is asked from the ECB table, base EUR', async () => {
    upstream({ ecb: [ecbTable()] });

    const rate = await freshFrankfurterClient().latest('JPY', 'USD');

    expect(requests.map((request) => request.url)).toEqual([ECB_TABLE_URL]);
    // USD-per-EUR over JPY-per-EUR: 1.25 / 200.5.
    expect(rate?.price).toBe('0.006234413965087281795511221945');
    expect(rate?.bank).toBe('ecb');
    expect(rate?.source).toBe('frankfurter');
  });

  test('EUR and RUB are priced from the CBR table only, and the ECB is never asked', async () => {
    upstream({ ecb: [ecbTable()], cbr: [cbrTable()] });
    const client = freshFrankfurterClient();

    const eurInRub = await client.latest('EUR', 'RUB');
    const rubInEur = await client.latest('RUB', 'EUR');

    expect(requests.map((request) => request.url)).toEqual([CBR_TABLE_URL]);
    // rate(USD to RUB) / rate(USD to EUR), and the other way round.
    expect(eurInRub?.price).toBe('194.5');
    expect(rubInEur?.price).toBe('0.005141388174807197943444730077');
    expect(eurInRub?.source).toBe('frankfurter-cbr');
  });

  test('a currency only the CBR publishes is a cross through USD', async () => {
    upstream({ cbr: [cbrTable()] });

    const rate = await freshFrankfurterClient().latest('KZT', 'USD');

    // 1 / rate(USD to KZT).
    expect(rate?.price).toBe('0.00221975582685904550499445061');
    expect(rate?.bank).toBe('cbr');
  });

  test('a pair no one bank publishes gives null and asks nothing', async () => {
    upstream({ ecb: [ecbTable()], cbr: [cbrTable()] });
    const client = freshFrankfurterClient();

    // ISK only in the ECB's table, RUB only in the CBR's; SOS in neither; the
    // metals and the SDR are left out of the routing table.
    for (const [from, to] of [
      ['RUB', 'ISK'],
      ['ISK', 'RUB'],
      ['SOS', 'USD'],
      ['XAU', 'USD'],
      ['XDR', 'RUB'],
    ] as const) {
      expect(await client.latest(from, to)).toBeNull();
      expect(await client.onDay(from, to, DAY)).toBeNull();
      expect(await client.range(from, to, DAY, DAY)).toEqual([]);
    }
    expect(requests).toEqual([]);

    // The same client prices a pair one bank does publish, so the nulls above
    // are its routing and not a client that answers nothing.
    expect((await client.latest('RUB', 'USD'))?.price).toBe('0.01028277634961439588688946015');
    expect(requests.map((request) => request.url)).toEqual([CBR_TABLE_URL]);
  });

  test('a day and a range name the bank and only the codes they need', async () => {
    upstream({ ecb: [ecbTable()], cbr: [cbrTable()] });
    const client = freshFrankfurterClient();

    await client.onDay('JPY', 'USD', DAY);
    await client.range('GBP', 'JPY', '2024-03-03', '2024-03-05');
    await client.onDay('RUB', 'USD', DAY);
    await client.range('EUR', 'RUB', '2024-03-03', '2024-03-05');

    expect(requests.map((request) => request.url)).toEqual([
      'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=JPY,USD&date=2024-03-04',
      'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=GBP,JPY&from=2024-03-03&to=2024-03-05',
      'https://api.frankfurter.dev/v2/providers/cbr/rates?base=USD&quotes=RUB&date=2024-03-04',
      'https://api.frankfurter.dev/v2/providers/cbr/rates?base=USD&quotes=EUR,RUB&from=2024-03-03&to=2024-03-05',
    ]);
  });

  test('a day or a range is asked every time, never kept', async () => {
    upstream({ cbr: [cbrTable()] });
    const client = freshFrankfurterClient();

    await client.onDay('RUB', 'USD', DAY);
    await client.onDay('RUB', 'USD', DAY);
    await client.range('RUB', 'USD', DAY, DAY);
    await client.range('RUB', 'USD', DAY, DAY);

    expect(requests.length).toBe(4);
  });

  test('a pair is found whatever the case of its symbols', async () => {
    upstream({ ecb: [ecbTable()] });

    const rate = await freshFrankfurterClient().latest('gbp', 'Eur');

    expect(rate?.price).toBe('1.25');
  });

  // CONTROL: what must stay null however the table is read.
  test('a currency missing from the table, or a zero or negative rate, gives null', async () => {
    upstream({ cbr: [cbrTable({ RUB: 0, KZT: -2, AED: 3.5 })] });
    const client = freshFrankfurterClient();

    for (const symbol of ['RUB', 'KZT', 'BYN']) {
      expect(await client.latest(symbol, 'USD')).toBeNull();
      expect(await client.latest('USD', symbol)).toBeNull();
    }
    // The same table still answers a pair it does hold. AED, because a pair of
    // two ECB currencies is asked from the ECB.
    expect((await client.latest('USD', 'AED'))?.price).toBe('3.5');
    expect(requests.map((request) => request.url)).toEqual([CBR_TABLE_URL]);
  });
});

describe('the one client of Frankfurter: what it keeps', () => {
  test('a bank table is kept for sixty minutes, and no longer', async () => {
    upstream({ ecb: [ecbTable()] });
    setSystemTime(NINE);
    const client = freshFrankfurterClient();

    await client.latest('USD', 'GBP');
    setSystemTime(minutesAfterNine(11));
    await client.latest('JPY', 'GBP');
    setSystemTime(new Date(minutesAfterNine(60).getTime() - 1));
    const stillKept = await client.latest('USD', 'EUR');
    expect(requests.map((request) => request.url)).toEqual([ECB_TABLE_URL]);
    expect(stillKept?.price).toBe('0.8');

    setSystemTime(minutesAfterNine(60));
    await client.latest('USD', 'EUR');
    expect(requests.map((request) => request.url)).toEqual([ECB_TABLE_URL, ECB_TABLE_URL]);
  });

  test('each bank’s table is kept on its own', async () => {
    upstream({ ecb: [ecbTable()], cbr: [cbrTable()] });
    setSystemTime(NINE);
    const client = freshFrankfurterClient();

    await client.latest('JPY', 'USD');
    await client.latest('RUB', 'USD');
    setSystemTime(minutesAfterNine(30));
    await client.latest('GBP', 'USD');
    await client.latest('KZT', 'USD');

    expect(requests.map((request) => request.url)).toEqual([ECB_TABLE_URL, CBR_TABLE_URL]);
  });

  test('callers that ask while a table is in flight share one request', async () => {
    upstream({ ecb: [ecbTable()] });
    const client = freshFrankfurterClient();

    const rates = await Promise.all([
      client.latest('USD', 'GBP'),
      client.latest('USD', 'GBP'),
      client.latest('EUR', 'GBP'),
    ]);

    expect(requests.length).toBe(1);
    expect(rates.map((rate) => rate?.price)).toEqual(['0.64', '0.64', '0.8']);
  });

  test('a failed request is not kept', async () => {
    upstream({
      ecb: [
        () => {
          throw new Error('socket closed');
        },
        refusal,
        () => Response.json({ status: 404, message: 'not found' }),
        ecbTable(),
      ],
    });
    const client = freshFrankfurterClient();

    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect((await client.latest('USD', 'GBP'))?.price).toBe('0.64');
    expect(requests.length).toBe(4);
  });

  test('an unknown code’s 422 gives null and is not kept', async () => {
    upstream({
      cbr: [
        () => Response.json({ status: 422, message: 'invalid currency: QQQ' }, { status: 422 }),
        cbrTable(),
      ],
    });
    const client = freshFrankfurterClient();

    expect(await client.latest('RUB', 'USD')).toBeNull();
    expect((await client.latest('RUB', 'USD'))?.price).toBe('0.01028277634961439588688946015');
    expect(requests.length).toBe(2);
  });

  test('a table whose rows carry another base gives null and is not kept', async () => {
    upstream({
      ecb: [
        ecbTable(ECB_RATES, 'USD'),
        () =>
          Response.json([
            ...fixing('EUR', DAY, { USD: 1.25 }),
            ...fixing('USD', DAY, { GBP: 0.64 }),
          ]),
        () => Response.json(fixing('EUR', DAY, ECB_RATES).map(({ base: _base, ...row }) => row)),
        ecbTable(),
      ],
    });
    const client = freshFrankfurterClient();

    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect((await client.latest('USD', 'GBP'))?.price).toBe('0.64');
    expect(requests.length).toBe(4);
  });

  test('a table with no usable rate is not kept', async () => {
    upstream({
      ecb: [
        () => Response.json([]),
        ecbTable({ EUR: 1 }),
        ecbTable({ EUR: 1, USD: 0, GBP: '0.8' }),
        ecbTable(),
      ],
    });
    const client = freshFrankfurterClient();

    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect(await client.latest('USD', 'GBP')).toBeNull();
    expect((await client.latest('USD', 'GBP'))?.price).toBe('0.64');
    expect(requests.length).toBe(4);
  });

  test('a rate that is not a number is skipped', async () => {
    // Written out as text: 1e999 is a number too large to be finite.
    const row = (quote: string, rate: string) =>
      `{"date":"${DAY}","base":"EUR","quote":"${quote}","rate":${rate}}`;
    upstream({
      ecb: [
        () =>
          new Response(
            `[${[
              row('USD', '1.25'),
              row('GBP', '"0.8"'),
              row('JPY', '[200.5]'),
              row('CHF', 'null'),
              row('CAD', '1e999'),
            ].join(',')}]`
          ),
      ],
    });
    const client = freshFrankfurterClient();

    expect((await client.latest('EUR', 'USD'))?.price).toBe('1.25');
    for (const symbol of ['GBP', 'JPY', 'CHF', 'CAD']) {
      expect(await client.latest(symbol, 'USD')).toBeNull();
    }
    expect(requests.length).toBe(1);
  });
});

describe('the one client of Frankfurter: its limiter', () => {
  test('every request takes its slot from the registry, under the frankfurter namespace', async () => {
    upstream({ ecb: [ecbTable()], cbr: [cbrTable()] });
    const { client, slots } = clientOverARecordedRegistry();

    await client.latest('JPY', 'USD');
    await client.onDay('RUB', 'USD', DAY);

    expect(slots.map((slot) => slot.namespace)).toEqual(['frankfurter', 'frankfurter']);
    expect(requests.length).toBe(2);
  });

  test('the budget is ten requests a second', async () => {
    upstream({ ecb: [refusal] });
    setSystemTime(NINE);
    const { client, limiters } = clientOverARecordedRegistry();

    // A refusal is not kept, so each ask is a request and takes a slot.
    for (let ask = 0; ask < 10; ask++) await client.latest('USD', 'GBP');

    expect(requests.length).toBe(10);
    expect(await limiters.get('frankfurter')?.tryConsume()).toEqual({
      ok: false,
      retryAfterMs: 1_000,
    });
  });

  // Taken at construction, the limiter would be whichever backend existed when
  // the client was first resolved, not the one the process ends up with.
  test('the limiter is taken from the registry when asking, not when the client is built', async () => {
    upstream({ ecb: [ecbTable()] });
    const { client, handedOut } = clientOverARecordedRegistry();
    expect(handedOut).not.toHaveBeenCalled();

    await client.latest('USD', 'GBP');

    expect(handedOut).toHaveBeenCalledTimes(1);
  });

  test('the request carries the ask’s abort signal', async () => {
    const bound = spyOn(AbortSignal, 'timeout');
    upstream({ ecb: [ecbTable()] });
    const { client, slots } = clientOverARecordedRegistry();

    await client.latest('USD', 'GBP');

    expect(bound.mock.calls).toEqual([[8_000]]);
    const signal = bound.mock.results[0]?.value as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]?.signal).toBe(signal);
    // The wait for a slot is under the same bound as the request.
    expect(slots[0]?.signal).toBe(signal);
  });

  test('an ask that cannot get a slot gives null and sends nothing', async () => {
    // The ask's own bound, cut short so the test does not wait it out.
    const bounds: number[] = [];
    spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      bounds.push(ms);
      return realTimeout.call(AbortSignal, 50);
    });
    // Frozen, so the window that the ten requests filled never moves on.
    setSystemTime(NINE);
    upstream({ ecb: [refusal] });
    const client = freshFrankfurterClient();
    // A refusal is not kept, so each ask is a request and takes one of the ten slots.
    for (let ask = 0; ask < 10; ask++) await client.latest('USD', 'GBP');
    expect(requests.length).toBe(10);

    const stillWaiting = 'still waiting for a slot';
    const eleventh = Promise.all([client.latest('USD', 'GBP'), client.onDay('USD', 'GBP', DAY)]);
    const outcome = await Promise.race([eleventh, Bun.sleep(1_000).then(() => stillWaiting)]);

    expect(outcome).toEqual([null, null]);
    expect(requests.length).toBe(10);
    expect(new Set(bounds)).toEqual(new Set([8_000]));
  });
});
