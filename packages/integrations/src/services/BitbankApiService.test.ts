import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { BitbankApiService } from './BitbankApiService';

const originalFetch = globalThis.fetch;

describe('BitbankApiService', () => {
  const service = new BitbankApiService('https://api.bitbank.cc');

  it('signs GET requests as hex(HMAC-SHA256(nonce + path, secret))', async () => {
    const apiKey = 'test-key';
    const apiSecret = 'test-secret';

    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ success: 1, data: { assets: [] } }), { status: 200 });
    }) as typeof globalThis.fetch;

    await service.getAssets(apiKey, apiSecret);

    const nonce = capturedHeaders!['ACCESS-NONCE']!;
    const expectedMessage = `${nonce}/v1/user/assets`;
    const expectedSig = crypto
      .createHmac('sha256', apiSecret)
      .update(expectedMessage)
      .digest('hex');
    expect(capturedHeaders?.['ACCESS-SIGNATURE']).toBe(expectedSig);
    expect(capturedHeaders?.['ACCESS-KEY']).toBe(apiKey);

    globalThis.fetch = originalFetch;
  });

  it('throws with the error code when bitbank returns success=0', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ success: 0, code: 20003 }), { status: 200 })
    ) as typeof globalThis.fetch;

    await expect(service.getAssets('k', 's')).rejects.toThrow(/bitbank error code 20003/);

    globalThis.fetch = originalFetch;
  });
});
