process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { CurrencyConverter } from '../../../src/services/pricing/CurrencyConverter';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const FIAT_TYPE = 'type-fiat';
const CRYPTO_TYPE = 'type-crypto';

function token(id: string, symbol: string, typeId: string): Token {
  return { id, symbol, typeId } as unknown as Token;
}

const GBP = token('t-gbp', 'GBP', FIAT_TYPE);
const USD = token('t-usd', 'USD', FIAT_TYPE);
const BTC = token('t-btc', 'BTC', CRYPTO_TYPE);

function makeService(
  storedRate: (from: { id: string }, to: { id: string }) => { rate: string; asOf: Date } | null,
  fiatTypeId: string | null = FIAT_TYPE
): { service: PricingService; asked: Array<string> } {
  const asked: string[] = [];
  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) =>
      code === 'fiat' && fiatTypeId ? { id: fiatTypeId, code } : null,
  } as unknown as TokenTypeRepository);
  Container.set(CurrencyConverter, {
    getStoredRateDetail: async (from: { id: string }, to: { id: string }) => {
      asked.push(`${from.id}->${to.id}`);
      return storedRate(from, to);
    },
  } as unknown as CurrencyConverter);
  const service = new PricingService();
  Container.set(PricingService, service);
  return { service, asked };
}

/**
 * SC-505. `forex-backfill` quotes every currency against the hub — `GBP -> USD`,
 * `EUR -> USD` — so USD is never itself the priced token and a USD cash balance
 * has no `token_prices` row a GBP-base user can be valued from. The price graph
 * answers it by inverting the row that does exist; this is the seam that asks.
 */
describe('PricingService.resolveFiatRatesToBase', () => {
  test('prices a fiat token that has no price row of its own', async () => {
    const { service, asked } = makeService(() => ({
      rate: '0.789266',
      asOf: new Date('2026-08-20T00:00:00Z'),
    }));

    const rates = await service.resolveFiatRatesToBase([USD], GBP, new Date());

    expect(asked).toEqual(['t-usd->t-gbp']);
    expect(rates.get('t-usd')?.price).toBe('0.789266');
    expect(rates.get('t-usd')?.baseTokenId).toBe('t-gbp');
    // Provenance is the point: this figure came from a rate we derived, not
    // from a row anyone can look up against this token.
    expect(rates.get('t-usd')?.source).toBe('price-graph');
    expect(rates.get('t-usd')?.timestamp).toEqual(new Date('2026-08-20T00:00:00Z'));
  });

  test('leaves non-fiat tokens alone', async () => {
    // A crypto or equity price is a market quote. The FX graph cannot derive
    // one, and answering with a rate would be inventing a number.
    const { service, asked } = makeService(() => ({ rate: '2', asOf: new Date() }));

    const rates = await service.resolveFiatRatesToBase([BTC], GBP, new Date());

    expect(asked).toEqual([]);
    expect(rates.size).toBe(0);
  });

  test('omits a pair the graph cannot route rather than returning zero', async () => {
    // Same contract as everything else here: absent means unpriceable. A '0'
    // would be a confident wrong number on a cash balance.
    const { service } = makeService(() => null);

    const rates = await service.resolveFiatRatesToBase([USD], GBP, new Date());

    expect(rates.has('t-usd')).toBe(false);
  });

  test('never asks for the base currency against itself', async () => {
    const { service, asked } = makeService(() => ({ rate: '1', asOf: new Date() }));

    const rates = await service.resolveFiatRatesToBase([GBP], GBP, new Date());

    expect(asked).toEqual([]);
    expect(rates.size).toBe(0);
  });
});
