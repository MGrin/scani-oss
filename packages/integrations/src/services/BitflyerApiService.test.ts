import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { BitflyerApiService } from './BitflyerApiService';

const originalFetch = globalThis.fetch;

describe('BitflyerApiService', () => {
  const service = new BitflyerApiService('https://api.bitflyer.com');

  it('signs requests as hex(HMAC-SHA256(timestamp + method + path + body, secret))', async () => {
    const apiKey = 'test-key';
    const apiSecret = 'test-secret';

    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof globalThis.fetch;

    await service.getBalances(apiKey, apiSecret);

    expect(capturedHeaders?.['ACCESS-KEY']).toBe(apiKey);
    const timestamp = capturedHeaders!['ACCESS-TIMESTAMP']!;
    const expectedMessage = `${timestamp}GET/v1/me/getbalance`;
    const expectedSig = crypto
      .createHmac('sha256', apiSecret)
      .update(expectedMessage)
      .digest('hex');
    expect(capturedHeaders?.['ACCESS-SIGN']).toBe(expectedSig);

    globalThis.fetch = originalFetch;
  });
});
