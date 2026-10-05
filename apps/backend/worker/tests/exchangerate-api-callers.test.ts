/**
 * exchangerate-api has three callers, and the worker boots all of them:
 * Frankfurter's fallback, the Google Sheets converter and `CurrencyConverter`
 * (foundation A3, Task 9). Each is built here the way `src/index.ts` builds
 * it, so a caller that made a client of its own would cost a second request.
 *
 * The converter reads and writes through the global connection, so its two
 * currencies are committed and removed after the test.
 */

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { CurrencyConverter } from '@scani/domain/services';
import {
  dropPricesOf,
  freshExchangeRateApiClient,
  makeToken,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { RateLimiterRegistry } from '@scani/providers/core/rate-limiter-registry';
import { makeMockToken } from '@scani/providers/core/testing';
import {
  type FrankfurterProvider,
  frankfurterFactory,
} from '@scani/providers/providers/frankfurter';
import { googleSheetsFactory } from '@scani/providers-google-sheets';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';

restoreContainerAfterAll();

const USD_TABLE_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

const NINE = new Date('2026-01-10T09:00:00Z');
const minutesAfterNine = (minutes: number) => new Date(NINE.getTime() + minutes * 60_000);

const usd = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
const rub = makeMockToken({ id: 'rub', symbol: 'RUB', name: 'RUB' });

const realFetch = globalThis.fetch;
const committed: string[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  setSystemTime();
  const tokens = committed.splice(0);
  await dropPricesOf(tokens);
  if (tokens.length > 0) {
    await getDb().delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  }
});

async function commitFiat(): Promise<Token> {
  const [fiat] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('the fiat token type is seeded by migration');
  const token = await getDb().transaction((tx) => makeToken(tx, { typeId: fiat.id }));
  committed.push(token.id);
  return token;
}

/** Answers every request with `rates` as the USD table, and records each URL asked. */
function answerEveryRequestWith(rates: Record<string, number>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return Response.json({ base: 'USD', rates });
  }) as unknown as typeof fetch;
  return requested;
}

/** The three callers as the worker's boot builds them, in a process whose client has asked nothing. */
async function bootCallers() {
  freshExchangeRateApiClient();
  Container.set(CurrencyConverter, new CurrencyConverter());
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
  return {
    frankfurter,
    convertSheetPrice: convertPriceFn,
    converter: Container.get(CurrencyConverter),
  };
}

describe('the callers of exchangerate-api, as the worker boots them', () => {
  test('three callers within sixty minutes cost one request, for the USD table', async () => {
    const from = await commitFiat();
    const to = await commitFiat();
    // Invented: units of each currency per one USD.
    const requested = answerEveryRequestWith({
      USD: 1,
      CAD: 1.25,
      RUB: 97.25,
      [from.symbol]: 2,
      [to.symbol]: 2.5,
    });
    setSystemTime(NINE);
    const { frankfurter, convertSheetPrice, converter } = await bootCallers();

    const quote = await frankfurter.fetchCurrentPrice(rub, { baseCurrency: usd });
    setSystemTime(minutesAfterNine(30));
    const outcome = await convertSheetPrice('50', 'CAD', 'USD', new Date());
    setSystemTime(minutesAfterNine(59));
    const detail = await converter.getRateDetail(from, to, new Date());

    expect(requested).toEqual([USD_TABLE_URL]);
    expect(quote?.source).toBe('exchangerate-api');
    expect(quote?.price).toBe('0.01028277634961439588688946015');
    expect(outcome).toEqual({ ok: true, price: '40' });
    expect(detail?.rate).toBe('1.25');
  });
});
