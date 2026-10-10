import { afterEach, describe, expect, it } from 'bun:test';
import { restoreContainerAfterAll } from '../../../business/domain/test/helpers/container';
import {
  CBR_TABLE_URL,
  ECB_TABLE_URL,
  fixing,
  outsideFrankfurterV2,
} from '../../../business/domain/test/helpers/frankfurter';
import { freshFrankfurterClient } from '../../../business/domain/test/helpers/frankfurter-client';
import { GoogleSheetsCurrencyConverter } from '../src/currency-converter';

// The client under each converter is installed in the process-global
// container; put back whatever this file changes (SC-448).
restoreContainerAfterAll();

const realFetch = globalThis.fetch;
let asked: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  // R25-6, R25-7: nothing this file asks leaves Frankfurter v2's named tables.
  expect(outsideFrankfurterV2(asked)).toEqual([]);
  asked = [];
});

/**
 * A converter over a Frankfurter client that has asked nothing, whose
 * upstream is `upstream`, and every URL that client asked.
 */
function converterOver(upstream: (url: string) => Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return upstream(url);
  }) as unknown as typeof fetch;
  return { converter: new GoogleSheetsCurrencyConverter(freshFrankfurterClient()), asked };
}

/** The ECB's table: units of each currency per one EUR. Invented figures. */
const ecbTable = (rates: Record<string, number>) =>
  Response.json(fixing('EUR', '2024-03-04', rates));

describe('GoogleSheetsCurrencyConverter', () => {
  it('reports a rate lookup that throws as a refusal, never as a number', async () => {
    const { converter } = converterOver(async () => {
      throw new Error('The operation was aborted.');
    });

    const outcome = await converter.convert('50', 'CAD', 'USD', new Date());

    expect(outcome.ok).toBe(false);
    // The refusal must not carry a price at all — the shape is what stops
    // a caller reading '50' back out and publishing it as USD.
    expect(outcome).not.toHaveProperty('price');
  });

  it('reports a non-ok upstream response as a refusal', async () => {
    const { converter } = converterOver(async () => new Response('nope', { status: 503 }));

    const outcome = await converter.convert('50', 'CAD', 'USD', new Date());

    expect(outcome.ok).toBe(false);
  });

  it('reports a table missing the requested currency as a refusal', async () => {
    const { converter } = converterOver(async () => ecbTable({ USD: 2, GBP: 0.8 }));

    const outcome = await converter.convert('50', 'CAD', 'USD', new Date());

    expect(outcome.ok).toBe(false);
  });

  it('reports a price that is not a number as a refusal that says so', async () => {
    const { converter } = converterOver(async () => ecbTable({ USD: 2, CAD: 2.5 }));

    const outcome = await converter.convert('#N/A', 'CAD', 'USD', new Date());

    expect(outcome).toEqual({
      ok: false,
      reason: "the price '#N/A' is not a number, so it cannot be expressed in USD",
    });
  });

  it('converts when upstream answers', async () => {
    const { converter } = converterOver(async () => ecbTable({ USD: 2, CAD: 2.5 }));

    const outcome = await converter.convert('50', 'CAD', 'USD', new Date());

    expect(outcome).toEqual({ ok: true, price: '40' });
  });

  it('asks for the ECB table whatever the ECB pair, and one table answers every such pair', async () => {
    const { converter, asked } = converterOver(async () =>
      ecbTable({ USD: 2, CAD: 2.5, GBP: 0.8 })
    );

    const outcomes = [
      await converter.convert('50', 'CAD', 'USD', new Date()),
      await converter.convert('10', 'EUR', 'GBP', new Date()),
      await converter.convert('8', 'USD', 'CAD', new Date()),
    ];

    expect(asked).toEqual([ECB_TABLE_URL]);
    expect(outcomes).toEqual([
      { ok: true, price: '40' },
      { ok: true, price: '8' },
      { ok: true, price: '10' },
    ]);
  });

  it('converts a price in RUB from the Bank of Russia’s table', async () => {
    const { converter, asked } = converterOver(async (url) =>
      url.includes('/providers/cbr/')
        ? Response.json(fixing('USD', '2024-03-04', { RUB: 80 }))
        : new Response('not found', { status: 404 })
    );

    // 1 / 80 terminates, so the product is exact.
    const outcome = await converter.convert('160', 'RUB', 'USD', new Date());

    expect(asked).toEqual([CBR_TABLE_URL]);
    expect(outcome).toEqual({ ok: true, price: '2' });
  });

  it('passes a same-currency price through without an upstream call', async () => {
    const { converter, asked } = converterOver(async () => {
      throw new Error('must not be called');
    });

    const outcome = await converter.convert('36', 'USD', 'USD', new Date());

    expect(outcome).toEqual({ ok: true, price: '36' });
    expect(asked).toEqual([]);
  });

  /**
   * SC-847: the converter used to cache `'0'` for ten minutes on any
   * failure. The batch loop converts tokens sequentially through this one
   * cache, so a negative entry written by the first token decided the
   * outcome for every later one — a distinct failure from a thrown
   * timeout, which caches nothing and so affects only the token that hit
   * it. Both shapes were observed in production.
   */
  it('does not let one failure decide the next caller (no negative caching)', async () => {
    let call = 0;
    const { converter } = converterOver(async () => {
      call += 1;
      if (call === 1) return new Response('nope', { status: 503 });
      return ecbTable({ USD: 2, CAD: 2.5 });
    });

    const outcomes = [
      await converter.convert('50', 'CAD', 'USD', new Date()),
      await converter.convert('25', 'CAD', 'USD', new Date()),
    ];

    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[1]).toEqual({ ok: true, price: '20' });
    expect(call).toBe(2);
  });

  it('caches a successful rate so a second token costs no upstream call', async () => {
    let call = 0;
    const { converter } = converterOver(async () => {
      call += 1;
      return ecbTable({ USD: 2, CAD: 2.5 });
    });

    const outcomes = [
      await converter.convert('50', 'CAD', 'USD', new Date()),
      await converter.convert('25', 'CAD', 'USD', new Date()),
    ];

    expect(outcomes[0]).toEqual({ ok: true, price: '40' });
    expect(outcomes[1]).toEqual({ ok: true, price: '20' });
    expect(call).toBe(1);
  });
});
