/**
 * What `CurrencyConverter` writes when neither its cache nor a stored rate
 * answers and it asks exchangerate-api (foundation A3, Tasks 6 and 9).
 *
 * The converter reads and writes through the global connection, so every row
 * here is committed and removed after each test. The upstream is replaced by
 * a client built for the test; nothing leaves the process.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { CurrencyConverter } from '../../../src/services/pricing/CurrencyConverter';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { freshExchangeRateApiClient } from '../../../test/helpers/exchangerate-api';
import { makeToken } from '../../../test/helpers/factories-extra';

// The converter takes its exchangerate-api client from the process-global
// container; put back whatever this file changes (SC-448).
restoreContainerAfterAll();

const rows = committedRows();
let fiatTypeId: string;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  const [fiat] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('the fiat token type is seeded by migration');
  fiatTypeId = fiat.id;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

async function commitFiat(): Promise<Token> {
  const token = await getDb().transaction((tx) => makeToken(tx, { typeId: fiatTypeId }));
  rows.tokens.push(token.id);
  return token;
}

/**
 * A converter whose exchangerate-api answers `usdTable`: units of each
 * currency per one USD. Invented figures. `asked` is every request made.
 */
function converterAnswering(usdTable: Record<string, number>): {
  converter: CurrencyConverter;
  asked: string[];
} {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return Response.json({ base: 'USD', rates: usdTable });
  }) as unknown as typeof fetch;
  freshExchangeRateApiClient();
  return { converter: new CurrencyConverter(), asked };
}

function storedFrom(tokenId: string) {
  return getDb().select().from(schema.tokenPrices).where(eq(schema.tokenPrices.tokenId, tokenId));
}

describe('CurrencyConverter write-back', () => {
  test('a fetched rate lands at the moment of the write, intraday, as exchangerate-api', async () => {
    const from = await commitFiat();
    const to = await commitFiat();
    const { converter } = converterAnswering({ [from.symbol]: 2, [to.symbol]: 2.5 });
    const before = Date.now();

    const detail = await converter.getRateDetail(from, to, new Date());

    const after = Date.now();
    expect(detail?.rate).toBe('1.25');
    const stored = await storedFrom(from.id);
    expect(stored.map((r) => [r.baseTokenId, r.price, r.source, r.granularity])).toEqual([
      [to.id, '1.25', 'exchangerate-api', 'intraday'],
    ]);
    const at = stored[0]?.timestamp.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  test('the converter asks exchangerate-api once, and for the USD table', async () => {
    const from = await commitFiat();
    const to = await commitFiat();
    const { converter, asked } = converterAnswering({ [from.symbol]: 2, [to.symbol]: 2.5 });

    await converter.getRateDetail(from, to, new Date());

    expect(asked).toEqual(['https://api.exchangerate-api.com/v4/latest/USD']);
  });

  // SC-1565. The column holds the division's own text: 1 / 97.25 at 28
  // significant digits. That it is stored at all is the column's CHECK passing.
  test('a low-value currency keeps its digits in the stored row', async () => {
    const from = await commitFiat();
    const to = await commitFiat();
    const { converter } = converterAnswering({ [from.symbol]: 97.25, [to.symbol]: 1 });

    const detail = await converter.getRateDetail(from, to, new Date());

    expect(detail?.rate).toBe('0.01028277634961439588688946015');
    const stored = await storedFrom(from.id);
    expect(stored.map((r) => [r.baseTokenId, r.price])).toEqual([
      [to.id, '0.01028277634961439588688946015'],
    ]);
  });

  test('a write that fails is logged and the rate is still returned', async () => {
    const from = await commitFiat();
    // A currency with no `tokens` row: the insert fails on its foreign key.
    const missing = { id: randomUUID(), symbol: 'ZZQ' };
    const { converter } = converterAnswering({ [from.symbol]: 2, ZZQ: 6 });

    const detail = await converter.getRateDetail(from, missing, new Date());

    expect(detail?.rate).toBe('3');
    expect(await storedFrom(from.id)).toEqual([]);
  });

  // CONTROL
  test('a currency missing from the table, or a zero or negative rate, gives null and writes nothing', async () => {
    const from = await commitFiat();
    const to = await commitFiat();

    for (const usdTable of [
      { [to.symbol]: 2.5 },
      { [from.symbol]: 0, [to.symbol]: 2.5 },
      { [from.symbol]: -2, [to.symbol]: 2.5 },
      { [from.symbol]: 2, [to.symbol]: 0 },
    ]) {
      const { converter } = converterAnswering(usdTable);
      expect(await converter.getRateDetail(from, to, new Date())).toBeNull();
      expect(await storedFrom(from.id)).toEqual([]);
    }
  });
});
