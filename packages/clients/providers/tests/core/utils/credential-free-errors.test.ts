import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { fetchWithTimeout, redactUrl } from '../../../src/core/utils/fetch';
import { ETHERSCAN_CHAINS, EtherscanProvider } from '../../../src/providers/etherscan';
import { IbkrProvider } from '../../../src/providers/ibkr';

/**
 * SC-1523. Two providers carry a credential in the query string — IBKR's Flex
 * token as `?t=` and our own Etherscan key as `apikey=` — and a network error
 * used to append the whole URL to the error message. That message is what the
 * worker logs, what BullMQ stores as the failure reason and what Sentry
 * receives, so the token went to all three.
 *
 * The rule is "no query VALUE in error text", not a list of parameter names:
 * the next provider to put a key in a URL should not need this file edited.
 */

const IBKR_TOKEN = '987654321098765432109876';
const ETHERSCAN_KEY = 'ZZSECRETETHERSCANKEY0123456789ABCD';

const passthroughLimiter = () =>
  ({ execute: async <T>(fn: () => Promise<T>) => fn() }) as unknown as OutflowRateLimiter;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function failNetwork() {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed: Unable to connect');
  }) as unknown as typeof fetch;
}

function everythingSaid(err: unknown): string {
  const e = err as Error;
  return `${e.message}\n${e.stack ?? ''}\n${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('a network error never carries a URL query value (SC-1523)', () => {
  test('IBKR: the Flex token is absent from the error a failed SendRequest raises', async () => {
    failNetwork();
    const provider = new IbkrProvider(passthroughLimiter(), async () => {});
    const err = await rejection(
      provider.fetchBalances({
        institutionCode: 'ibkr',
        baseCurrency: { id: 'usd', symbol: 'USD' },
        credentialsRef: { userId: 'u', institutionId: 'i' },
        resolveCredentials: async () => ({ flexQueryToken: IBKR_TOKEN, flexQueryId: '123456' }),
      } as never)
    );
    const said = everythingSaid(err);
    expect(said).not.toContain(IBKR_TOKEN);
    // Control: the failure itself still reaches the reader.
    expect(said).toContain('Unable to connect');
  });

  test('Etherscan: our API key is absent from the error a failed request raises', async () => {
    failNetwork();
    const provider = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), ETHERSCAN_KEY);
    const err = await rejection(
      provider.hasActivity('0x1523000000000000000000000000000000000001', 'ethereum', {} as never)
    );
    const said = everythingSaid(err);
    expect(said).not.toContain(ETHERSCAN_KEY);
    expect(said).toContain('Unable to connect');
  });

  test('the URL is still named, with every query value blanked and every name kept', async () => {
    failNetwork();
    const err = await rejection(
      fetchWithTimeout('https://api.example.com/v2/api?chainid=1&apikey=SECRETVALUE&x=1', {}, 50, 0)
    );
    const said = everythingSaid(err);
    expect(said).not.toContain('SECRETVALUE');
    expect(said).toContain('https://api.example.com/v2/api?chainid=…&apikey=…&x=…');
  });
});

describe('redactUrl', () => {
  test('blanks every query value, whatever the parameter is called', () => {
    expect(redactUrl('https://h.example/p?t=123&q=456&v=3')).toBe(
      'https://h.example/p?t=…&q=…&v=…'
    );
  });

  test('drops credentials in the authority', () => {
    expect(redactUrl('https://user:pass@h.example/p')).toBe('https://h.example/p');
  });

  test('a URL without a query is unchanged', () => {
    expect(redactUrl('https://h.example/p')).toBe('https://h.example/p');
  });

  test('text that is not a URL says so rather than echoing it', () => {
    expect(redactUrl('not a url?t=SECRET')).not.toContain('SECRET');
  });
});
