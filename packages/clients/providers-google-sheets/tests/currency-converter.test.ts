import { describe, expect, it } from 'bun:test';
import { GoogleSheetsCurrencyConverter } from '../src/currency-converter';

/**
 * A limiter that just runs the work — the real one is Redis-backed.
 */
const passthroughLimiter = {
  execute: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
} as unknown as ConstructorParameters<typeof GoogleSheetsCurrencyConverter>[0];

/** Bun's `fetch` type carries a `preconnect` member a stub has no use for. */
type FetchImpl = () => Promise<Response>;

function withFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const rateResponse = (rates: Record<string, number>) =>
  new Response(JSON.stringify({ rates }), { status: 200 });

describe('GoogleSheetsCurrencyConverter', () => {
  it('reports a rate lookup that throws as a refusal, never as a number', async () => {
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);

    const outcome = await withFetch(
      async () => {
        throw new Error('The operation was aborted.');
      },
      () => converter.convert('50', 'CAD', 'USD', new Date())
    );

    expect(outcome.ok).toBe(false);
    // The refusal must not carry a price at all — the shape is what stops
    // a caller reading '50' back out and publishing it as USD.
    expect(outcome).not.toHaveProperty('price');
  });

  it('reports a non-ok upstream response as a refusal', async () => {
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);

    const outcome = await withFetch(
      async () => new Response('nope', { status: 503 }),
      () => converter.convert('50', 'CAD', 'USD', new Date())
    );

    expect(outcome.ok).toBe(false);
  });

  it('reports a payload missing the requested pair as a refusal', async () => {
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);

    const outcome = await withFetch(
      async () => rateResponse({ EUR: 0.68 }),
      () => converter.convert('50', 'CAD', 'USD', new Date())
    );

    expect(outcome.ok).toBe(false);
  });

  it('converts when upstream answers', async () => {
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);

    const outcome = await withFetch(
      async () => rateResponse({ USD: 0.72 }),
      () => converter.convert('50', 'CAD', 'USD', new Date())
    );

    expect(outcome).toEqual({ ok: true, price: '36' });
  });

  it('passes a same-currency price through without an upstream call', async () => {
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);

    const outcome = await withFetch(
      async () => {
        throw new Error('must not be called');
      },
      () => converter.convert('36', 'USD', 'USD', new Date())
    );

    expect(outcome).toEqual({ ok: true, price: '36' });
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
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);
    let call = 0;

    const outcomes = await withFetch(
      async () => {
        call += 1;
        if (call === 1) return new Response('nope', { status: 503 });
        return rateResponse({ USD: 0.72 });
      },
      async () => [
        await converter.convert('50', 'CAD', 'USD', new Date()),
        await converter.convert('25', 'CAD', 'USD', new Date()),
      ]
    );

    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[1]).toEqual({ ok: true, price: '18' });
    expect(call).toBe(2);
  });

  it('caches a successful rate so a second token costs no upstream call', async () => {
    const converter = new GoogleSheetsCurrencyConverter(passthroughLimiter);
    let call = 0;

    const outcomes = await withFetch(
      async () => {
        call += 1;
        return rateResponse({ USD: 0.72 });
      },
      async () => [
        await converter.convert('50', 'CAD', 'USD', new Date()),
        await converter.convert('25', 'CAD', 'USD', new Date()),
      ]
    );

    expect(outcomes[0]).toEqual({ ok: true, price: '36' });
    expect(outcomes[1]).toEqual({ ok: true, price: '18' });
    expect(call).toBe(1);
  });
});
