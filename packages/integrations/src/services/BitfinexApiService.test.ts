import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { BitfinexApiService } from './BitfinexApiService';

const originalFetch = globalThis.fetch;

describe('BitfinexApiService', () => {
  const service = new BitfinexApiService('https://api.bitfinex.com');

  it('signs requests as hex(HMAC-SHA384("/api/" + path + nonce + body, secret))', async () => {
    const apiKey = 'test-key';
    const apiSecret = 'test-secret';

    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof globalThis.fetch;

    await service.getWallets(apiKey, apiSecret);

    expect(capturedHeaders?.['bfx-apikey']).toBe(apiKey);
    expect(capturedHeaders?.['bfx-nonce']).toBeDefined();
    expect(capturedHeaders?.['bfx-signature']).toBeDefined();
    expect(capturedBody).toBe('{}');

    const nonce = capturedHeaders!['bfx-nonce']!;
    const expectedMessage = `/api/v2/auth/r/wallets${nonce}{}`;
    const expectedSig = crypto
      .createHmac('sha384', apiSecret)
      .update(expectedMessage)
      .digest('hex');
    expect(capturedHeaders?.['bfx-signature']).toBe(expectedSig);

    globalThis.fetch = originalFetch;
  });
});
