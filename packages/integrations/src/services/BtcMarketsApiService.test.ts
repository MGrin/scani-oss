import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { BtcMarketsApiService } from './BtcMarketsApiService';

const originalFetch = globalThis.fetch;

describe('BtcMarketsApiService', () => {
  const service = new BtcMarketsApiService('https://api.btcmarkets.net');

  it('signs requests as base64(HMAC-SHA512(path\\ntimestamp\\nbody, base64Decode(secret)))', async () => {
    // Known-good inputs → manually compute what the signature should be.
    const apiKey = 'test-key';
    // Arbitrary 64-byte base64 secret so Buffer.from(secret,'base64')
    // decodes to real bytes.
    const apiSecret = Buffer.from('a'.repeat(64)).toString('base64');

    let capturedHeaders: Record<string, string> | undefined;
    let capturedTimestamp: string | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedTimestamp = capturedHeaders['BM-AUTH-TIMESTAMP'];
      return new Response(
        JSON.stringify([{ assetName: 'BTC', balance: '1.0', available: '1.0', locked: '0' }]),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;

    await service.getBalances(apiKey, apiSecret);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.['BM-AUTH-APIKEY']).toBe(apiKey);
    expect(capturedTimestamp).toBeDefined();

    // Recompute the signature with the captured timestamp and confirm
    // the service produced it exactly.
    const expectedStringToSign = `/v3/accounts/me/balances\n${capturedTimestamp}\n`;
    const expectedSignature = crypto
      .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
      .update(expectedStringToSign)
      .digest('base64');
    expect(capturedHeaders?.['BM-AUTH-SIGNATURE']).toBe(expectedSignature);

    globalThis.fetch = originalFetch;
  });

  it('rejects non-base64 secrets in validateApiKey without calling fetch', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('', { status: 200 })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    // Empty-decoded secret (all whitespace in base64 decodes to empty).
    const isValid = await service.validateApiKey('key', '');
    expect(isValid).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);

    globalThis.fetch = originalFetch;
  });
});
