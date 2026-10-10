/**
 * Frankfurter has two callers, and the worker boots both: the Frankfurter
 * provider and the Google Sheets converter (foundation A3, Tasks 9 and 25a;
 * the base-currency converter that was a third went in Task 18). Each is
 * built here the way `src/index.ts` builds it, so a caller that made a client
 * of its own would cost a second request for a table the process already
 * holds. Each bank's table is asked by both, so that holds whichever caller
 * it is.
 *
 * The client is the file's own: `restoreContainerAfterAll` installs a fresh
 * one, and this is the only test that asks it.
 */

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { getDb } from '@scani/db';
import {
  CBR_TABLE_URL,
  ECB_TABLE_URL,
  fixing,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { RateLimiterRegistry } from '@scani/providers/core/rate-limiter-registry';
import { makeMockToken } from '@scani/providers/core/testing';
import {
  type FrankfurterProvider,
  frankfurterFactory,
} from '@scani/providers/providers/frankfurter';
import { googleSheetsFactory } from '@scani/providers-google-sheets';

restoreContainerAfterAll();

const NINE = new Date('2026-01-10T09:00:00Z');
const minutesAfterNine = (minutes: number) => new Date(NINE.getTime() + minutes * 60_000);

const usd = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
const rub = makeMockToken({ id: 'rub', symbol: 'RUB', name: 'RUB' });
const gbp = makeMockToken({ id: 'gbp', symbol: 'GBP', name: 'GBP' });

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

/**
 * Answers the ECB's table with `ecb` (units per one EUR) and the CBR's with
 * `cbr` (units per one USD); anything else refuses. Records each URL asked.
 */
function answerEachBank(ecb: Record<string, number>, cbr: Record<string, number>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (url === ECB_TABLE_URL) return Response.json(fixing('EUR', '2026-01-09', ecb));
    if (url === CBR_TABLE_URL) return Response.json(fixing('USD', '2026-01-09', cbr));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return requested;
}

/** The two callers as the worker's boot builds them. */
async function bootCallers() {
  const rateLimiterRegistry = new RateLimiterRegistry();
  const frankfurter = (await frankfurterFactory({
    redis: null,
    env: {},
    rateLimiterRegistry,
    reportCredentialStatus: () => {},
  })) as FrankfurterProvider;
  const sheets = googleSheetsFactory({ db: getDb(), redis: null, rateLimiterRegistry });
  // The provider's public route to its converter needs a live spreadsheet row.
  const { convertPriceFn } = sheets as unknown as {
    convertPriceFn: (price: string, from: string, to: string, at: Date) => Promise<unknown>;
  };
  return { frankfurter, convertSheetPrice: convertPriceFn };
}

describe('the callers of Frankfurter, as the worker boots them', () => {
  test('both callers within sixty minutes cost one request per bank table', async () => {
    // Invented figures.
    const requested = answerEachBank({ USD: 2, CAD: 2.5, GBP: 0.8, JPY: 160 }, { RUB: 50 });
    setSystemTime(NINE);
    const { frankfurter, convertSheetPrice } = await bootCallers();

    // The CBR's table: the provider, then the Sheets converter.
    const rubQuote = await frankfurter.fetchCurrentPrice(rub, { baseCurrency: usd });
    setSystemTime(minutesAfterNine(10));
    const rubSheet = await convertSheetPrice('100', 'RUB', 'USD', new Date());
    // The ECB's table: the Sheets converter, then the provider.
    setSystemTime(minutesAfterNine(20));
    const cadSheet = await convertSheetPrice('50', 'CAD', 'USD', new Date());
    setSystemTime(minutesAfterNine(59));
    const gbpQuote = await frankfurter.fetchCurrentPrice(gbp, { baseCurrency: usd });

    expect(requested).toEqual([CBR_TABLE_URL, ECB_TABLE_URL]);
    expect(rubQuote?.source).toBe('frankfurter-cbr');
    expect(rubQuote?.price).toBe('0.02');
    expect(rubSheet).toEqual({ ok: true, price: '2' });
    expect(cadSheet).toEqual({ ok: true, price: '40' });
    expect(gbpQuote?.source).toBe('frankfurter');
    expect(gbpQuote?.price).toBe('2.5');
  });
});
