import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { IndependentReserveApiService } from './IndependentReserveApiService';

const originalFetch = globalThis.fetch;

describe('IndependentReserveApiService', () => {
  const service = new IndependentReserveApiService('https://api.independentreserve.com');

  it('signs requests as hex(HMAC-SHA256(URL + ",apiKey=" + key + ",nonce=" + nonce, secret))', async () => {
    const apiKey = 'test-key';
    const apiSecret = 'test-secret';

    let capturedBody: Record<string, string> | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof globalThis.fetch;

    await service.getAccounts(apiKey, apiSecret);

    expect(capturedBody?.apiKey).toBe(apiKey);
    expect(capturedBody?.nonce).toBeDefined();
    const nonce = capturedBody!.nonce!;

    const url = 'https://api.independentreserve.com/Private/GetAccounts';
    const expectedMessage = [url, `apiKey=${apiKey}`, `nonce=${nonce}`].join(',');
    const expectedSig = crypto
      .createHmac('sha256', apiSecret)
      .update(expectedMessage)
      .digest('hex');
    expect(capturedBody?.signature).toBe(expectedSig);

    globalThis.fetch = originalFetch;
  });
});
