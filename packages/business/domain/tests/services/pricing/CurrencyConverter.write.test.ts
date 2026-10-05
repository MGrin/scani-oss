/**
 * Characterization (foundation A3, Task 6): what `CurrencyConverter` writes
 * when neither its cache nor a stored rate answers and it asks
 * exchangerate-api, before and after the write moves onto `PriceWriter`.
 *
 * The converter reads and writes through the global connection, so every row
 * here is committed and removed after each test. The upstream call is
 * replaced; nothing leaves the process.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { CurrencyConverter } from '../../../src/services/pricing/CurrencyConverter';
import { committedRows, dropPricesOf } from '../../../test/helpers/committed-rows';
import { makeToken } from '../../../test/helpers/factories-extra';

const rows = committedRows();
let fiatTypeId: string;

beforeAll(async () => {
  const [fiat] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('the fiat token type is seeded by migration');
  fiatTypeId = fiat.id;
});

afterEach(async () => {
  await dropPricesOf(rows.tokens);
  await rows.drop();
});

async function commitFiat(): Promise<Token> {
  const token = await getDb().transaction((tx) => makeToken(tx, { typeId: fiatTypeId }));
  rows.tokens.push(token.id);
  return token;
}

/** A converter whose exchangerate-api answers `rates` for any base asked. */
function converterAnswering(rates: Record<string, number>): CurrencyConverter {
  const converter = new CurrencyConverter();
  (converter as unknown as { exchangeRateFetch: () => Promise<Response> }).exchangeRateFetch =
    async () => Response.json({ rates });
  return converter;
}

function storedFrom(tokenId: string) {
  return getDb().select().from(schema.tokenPrices).where(eq(schema.tokenPrices.tokenId, tokenId));
}

describe('CurrencyConverter write-back', () => {
  test('a fetched rate lands at the moment of the write, intraday, as exchangerate-api', async () => {
    const from = await commitFiat();
    const to = await commitFiat();
    const converter = converterAnswering({ [to.symbol]: 1.25 });
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

  test('a write that fails is logged and the rate is still returned', async () => {
    const from = await commitFiat();
    // A currency with no `tokens` row: the insert fails on its foreign key.
    const missing = { id: randomUUID(), symbol: 'ZZQ' };
    const converter = converterAnswering({ ZZQ: 3 });

    const detail = await converter.getRateDetail(from, missing, new Date());

    expect(detail?.rate).toBe('3');
    expect(await storedFrom(from.id)).toEqual([]);
  });
});
