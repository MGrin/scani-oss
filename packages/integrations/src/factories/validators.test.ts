import { afterEach, describe, expect, it, mock } from 'bun:test';
import { validateBinanceCredentials } from './binanceFactory';
import { validateBitgetCredentials } from './bitgetFactory';
import { validateBitstampCredentials } from './bitstampFactory';
import { validateBybitCredentials } from './bybitFactory';
import { validateCoinbaseCredentials } from './coinbaseFactory';
import { validateGateioCredentials } from './gateioFactory';
import { validateGeminiCredentials } from './geminiFactory';
import { validateHuobiCredentials } from './huobiFactory';
import { validateIbkrCredentials } from './ibkrFactory';
import { validateKrakenCredentials } from './krakenFactory';
import { validateKucoinCredentials } from './kucoinFactory';
import { validateMexcCredentials } from './mexcFactory';
import { validateOkxCredentials } from './okxFactory';
import { validateWiseCredentials } from './wiseFactory';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Helper: mock a successful API response
function _mockSuccess(body: unknown = {}) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  );
}

// Helper: mock a 401 response
function _mock401() {
  globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));
}

// Helper: mock network error
function mockNetworkError() {
  globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));
}

describe('Exchange credential validators', () => {
  // All validators should return false on network error
  const validators = [
    { name: 'Binance', fn: () => validateBinanceCredentials('key', 'secret') },
    { name: 'Kraken', fn: () => validateKrakenCredentials('key', 'secret') },
    { name: 'Bybit', fn: () => validateBybitCredentials('key', 'secret') },
    { name: 'Coinbase', fn: () => validateCoinbaseCredentials('key', 'secret') },
    { name: 'Bitstamp', fn: () => validateBitstampCredentials('key', 'secret') },
    { name: 'Gemini', fn: () => validateGeminiCredentials('key', 'secret') },
    { name: 'Mexc', fn: () => validateMexcCredentials('key', 'secret') },
    { name: 'Gateio', fn: () => validateGateioCredentials('key', 'secret') },
    { name: 'Huobi', fn: () => validateHuobiCredentials('key', 'secret') },
    { name: 'OKX', fn: () => validateOkxCredentials('key', 'secret', 'pass') },
    { name: 'KuCoin', fn: () => validateKucoinCredentials('key', 'secret', 'pass') },
    { name: 'Bitget', fn: () => validateBitgetCredentials('key', 'secret', 'pass') },
    { name: 'Wise', fn: () => validateWiseCredentials('token') },
    { name: 'IBKR', fn: () => validateIbkrCredentials('token', 'queryId') },
  ];

  for (const { name, fn } of validators) {
    it(`${name}: should return false on network error`, async () => {
      mockNetworkError();
      const result = await fn();
      expect(result).toBe(false);
    });
  }
});
