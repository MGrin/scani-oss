import { afterEach, describe, expect, it } from 'bun:test';
import { restoreContainerAfterAll } from '../../../business/domain/test/helpers/container';
import { freshExchangeRateApiClient } from '../../../business/domain/test/helpers/exchangerate-api';
import { GoogleSheetsCurrencyConverter } from '../src/currency-converter';

// The client under each converter is installed in the process-global
// container; put back whatever this file changes (SC-448).
restoreContainerAfterAll();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A converter over an exchangerate-api client that has asked nothing, whose
 * upstream is `upstream`, and every URL that client asked.
 */
function converterOver(upstream: () => Promise<Response>) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return upstream();
  }) as unknown as typeof fetch;
  return { converter: new GoogleSheetsCurrencyConverter(freshExchangeRateApiClient()), asked };
}

/** The upstream's table: units of each currency per one USD. Invented figures. */
const usdTable = (rates: Record<string, number>) => Response.json({ base: 'USD', rates });

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
    const { converter } = converterOver(async () => usdTable({ USD: 1, EUR: 0.8 }));

    const outcome = await converter.convert('50', 'CAD', 'USD', new Date());

    expect(outcome.ok).toBe(false);
  });

  it('reports a price that is not a number as a refusal that says so', async () => {
    const { converter } = converterOver(async () => usdTable({ USD: 1, CAD: 1.25 }));

    const outcome = await converter.convert('#N/A', 'CAD', 'USD', new Date());

    expect(outcome).toEqual({
      ok: false,
      reason: "the price '#N/A' is not a number, so it cannot be expressed in USD",
    });
  });

  it('converts when upstream answers', async () => {
    const { converter } = converterOver(async () => usdTable({ USD: 1, CAD: 1.25 }));

    const outcome = await converter.convert('50', 'CAD', 'USD', new Date());

    expect(outcome).toEqual({ ok: true, price: '40' });
  });

  it('asks for the USD table whatever the pair, and one table answers every pair', async () => {
    const { converter, asked } = converterOver(async () =>
      usdTable({ USD: 1, CAD: 1.25, EUR: 0.8, GBP: 0.64 })
    );

    const outcomes = [
      await converter.convert('50', 'CAD', 'USD', new Date()),
      await converter.convert('10', 'EUR', 'GBP', new Date()),
      await converter.convert('8', 'USD', 'CAD', new Date()),
    ];

    expect(asked).toEqual(['https://api.exchangerate-api.com/v4/latest/USD']);
    expect(outcomes).toEqual([
      { ok: true, price: '40' },
      { ok: true, price: '8' },
      { ok: true, price: '10' },
    ]);
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
      return usdTable({ USD: 1, CAD: 1.25 });
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
      return usdTable({ USD: 1, CAD: 1.25 });
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
