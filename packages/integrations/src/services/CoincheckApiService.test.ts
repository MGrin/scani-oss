import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { CoincheckApiService } from './CoincheckApiService';

const originalFetch = globalThis.fetch;

describe('CoincheckApiService', () => {
  const service = new CoincheckApiService('https://coincheck.com');

  it('signs requests as hex(HMAC-SHA256(nonce + FULL url + body, secret))', async () => {
    const apiKey = 'test-key';
    const apiSecret = 'test-secret';

    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ success: true, jpy: '100.0', btc: '0.5' }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    await service.getBalances(apiKey, apiSecret);

    const nonce = capturedHeaders!['ACCESS-NONCE']!;
    // Full URL including host — NOT just path.
    const expectedMessage = `${nonce}https://coincheck.com/api/accounts/balance`;
    const expectedSig = crypto
      .createHmac('sha256', apiSecret)
      .update(expectedMessage)
      .digest('hex');
    expect(capturedHeaders?.['ACCESS-SIGNATURE']).toBe(expectedSig);
    expect(capturedHeaders?.['ACCESS-KEY']).toBe(apiKey);

    globalThis.fetch = originalFetch;
  });

  it('filters suffixed metadata keys from the balance response', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            jpy: '1000',
            btc: '0.1',
            jpy_reserved: '50',
            btc_lend_in_use: '0.01',
          }),
          { status: 200 }
        )
    ) as typeof globalThis.fetch;

    const balances = await service.getBalances('key', 'secret');
    const currencies = balances.map((b) => b.currency).sort();
    expect(currencies).toEqual(['btc', 'jpy']);

    globalThis.fetch = originalFetch;
  });
});
