import { describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import { TigerApiService } from './TigerApiService';

const originalFetch = globalThis.fetch;

// Generate a real 2048-bit RSA keypair at test-load time so the OpenSSL
// backend accepts it for signing. Much more reliable than hardcoding a
// hand-typed fake PEM.
const { privateKey: TEST_PRIVATE_PKCS8 } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('TigerApiService', () => {
  const service = new TigerApiService('https://openapi.tigerfintech.com');

  it('builds the signed string as alphabetically-sorted key=value joined by &', async () => {
    let capturedBody: Record<string, string> | undefined;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 });
    }) as typeof globalThis.fetch;

    await service.getAccounts('tiger-id-123', TEST_PRIVATE_PKCS8);

    expect(capturedBody?.tiger_id).toBe('tiger-id-123');
    expect(capturedBody?.method).toBe('accounts');
    expect(capturedBody?.sign_type).toBe('RSA');
    expect(capturedBody?.charset).toBe('UTF-8');
    expect(capturedBody?.biz_content).toBe('{}');
    expect(capturedBody?.sign).toBeDefined();

    // Recompute the signature: sorted alphabetically, excluding `sign`,
    // k=v joined with &. Then RSA-SHA1 signed.
    const allButSign = Object.entries(capturedBody!).filter(([k]) => k !== 'sign');
    const stringToSign = allButSign
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const expectedSig = crypto
      .createSign('RSA-SHA1')
      .update(stringToSign, 'utf8')
      .sign(TEST_PRIVATE_PKCS8, 'base64');
    expect(capturedBody?.sign).toBe(expectedSig);

    globalThis.fetch = originalFetch;
  });

  it('surfaces non-zero gateway error codes as "Tiger Brokers error N"', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ code: 40001, message: 'sign invalid' }), { status: 200 })
    ) as typeof globalThis.fetch;

    await expect(service.getAccounts('id', TEST_PRIVATE_PKCS8)).rejects.toThrow(
      /Tiger Brokers error 40001/
    );

    globalThis.fetch = originalFetch;
  });
});
