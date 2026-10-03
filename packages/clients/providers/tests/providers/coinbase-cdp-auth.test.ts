import { afterEach, describe, expect, test } from 'bun:test';
import { type KeyObject, verify } from 'node:crypto';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { CoinbaseProvider } from '../../src/providers/coinbase';
import { coinbaseManifest } from '../../src/providers/coinbase/manifest';
import { throwawayCdpKey } from '../helpers/cdp-key';

/**
 * The connect page tells the user to create a Coinbase Developer Platform key
 * (ECDSA) and download its JSON. Such a key authenticates only through a
 * short-lived ES256 JWT in `Authorization: Bearer`; the legacy
 * `CB-ACCESS-*` HMAC headers are rejected for it, so a provider signing those
 * could never connect (SC-1524).
 */

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch(respond: (url: URL) => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    return respond(url);
  }) as unknown as typeof fetch;
  return sent;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function readJwt(sent: Sent, publicKey: KeyObject) {
  const auth = sent.headers.get('authorization') ?? '';
  expect(auth.startsWith('Bearer ')).toBe(true);
  const token = auth.slice('Bearer '.length);
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error(`not a JWT: ${token}`);
  const signatureValid = verify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')
  );
  return { header: decodeSegment(header), claims: decodeSegment(payload), signatureValid };
}

function cbAccessHeaders(sent: Sent): string[] {
  return [...sent.headers.keys()].filter((name) => name.toLowerCase().startsWith('cb-access'));
}

const account = {
  id: 'acct-1',
  name: 'BTC Wallet',
  type: 'wallet',
  currency: { code: 'BTC', name: 'Bitcoin' },
  balance: { amount: '1', currency: 'BTC' },
};

function ctxFor(creds: Record<string, string>) {
  return {
    institutionCode: 'coinbase',
    baseCurrency: { id: 'usd', symbol: 'USD' },
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => creds,
  } as never;
}

describe('Coinbase authenticates with the CDP key the setup steps ask for', () => {
  test('each request carries an ES256 JWT bound to its own method, host and path', async () => {
    const key = throwawayCdpKey();
    const sent = captureFetch((url) => {
      if (url.pathname === '/v2/accounts') {
        return Response.json({ data: [account], pagination: { next_uri: null } });
      }
      return Response.json({ data: [], pagination: { next_uri: null } });
    });

    const before = Math.floor(Date.now() / 1000);
    await new CoinbaseProvider(passthroughLimiter()).fetchTransactions(
      ctxFor({ apiKey: key.name, apiSecret: key.privateKeyPem })
    );
    const after = Math.floor(Date.now() / 1000);

    expect(sent.map((s) => s.url.pathname)).toEqual([
      '/v2/accounts',
      '/v2/accounts/acct-1/transactions',
    ]);
    const nonces = new Set<unknown>();
    for (const request of sent) {
      expect(cbAccessHeaders(request)).toEqual([]);
      const { header, claims, signatureValid } = readJwt(request, key.publicKey);
      expect(signatureValid).toBe(true);
      expect(header.alg).toBe('ES256');
      expect(header.kid).toBe(key.name);
      expect(header.nonce).toMatch(/^[0-9a-f]{16,}$/);
      nonces.add(header.nonce);
      expect(claims.sub).toBe(key.name);
      expect(claims.iss).toBe('cdp');
      expect(claims.nbf).toBeGreaterThanOrEqual(before);
      expect(claims.nbf).toBeLessThanOrEqual(after);
      expect(claims.exp).toBe((claims.nbf as number) + 120);
      // The query string is not part of the signed uri — Coinbase's own
      // clients sign `<METHOD> <host><path>` and send params beside it.
      expect(claims.uri).toBe(`${request.method} ${request.url.host}${request.url.pathname}`);
    }
    expect(nonces.size).toBe(sent.length);
  });

  test('a private key pasted with JSON-escaped newlines signs the same way', async () => {
    const key = throwawayCdpKey();
    const escaped = `"${key.privateKeyPem.trim().replaceAll('\n', '\\n')}\\n"`;
    const sent = captureFetch(() => Response.json({ data: [], pagination: { next_uri: null } }));

    const result = await new CoinbaseProvider(passthroughLimiter()).validateCredentials(
      { apiKey: key.name, apiSecret: escaped },
      'coinbase'
    );

    expect(result).toEqual({ valid: true });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    if (!request) throw new Error('no request sent');
    expect(readJwt(request, key.publicKey).signatureValid).toBe(true);
  });

  test.each([401, 403])('validateCredentials reads a %d as a rejected key', async (status) => {
    const key = throwawayCdpKey();
    const sent = captureFetch(() => new Response('Unauthorized', { status }));

    const result = await new CoinbaseProvider(passthroughLimiter()).validateCredentials(
      { apiKey: key.name, apiSecret: key.privateKeyPem },
      'coinbase'
    );

    expect(result.valid).toBe(false);
    expect(result.message).toContain(`coinbase HTTP ${status}`);
    const [request] = sent;
    if (!request) throw new Error('no request sent');
    expect(cbAccessHeaders(request)).toEqual([]);
    expect(readJwt(request, key.publicKey).signatureValid).toBe(true);
  });

  test('a key that is not an ECDSA PEM is rejected before anything is sent', async () => {
    const sent = captureFetch(() => Response.json({ data: [] }));
    const ed25519Shaped = Buffer.alloc(64, 7).toString('base64');

    const result = await new CoinbaseProvider(passthroughLimiter()).validateCredentials(
      { apiKey: 'organizations/o/apiKeys/k', apiSecret: ed25519Shaped },
      'coinbase'
    );

    expect(result.valid).toBe(false);
    expect(result.message).toContain('ECDSA');
    expect(result.message).not.toContain(ed25519Shaped);
    expect(sent).toHaveLength(0);
  });
});

describe('the setup steps name the fields the adapter reads', () => {
  const { steps } = coinbaseManifest.instructions;
  const fieldNamedBy = (jsonKey: string) => {
    const step = steps.find((s) => s.includes(`"${jsonKey}"`));
    expect(step).toBeDefined();
    const field = coinbaseManifest.credentialFields.find((f) => step?.includes(`"${f.label}"`));
    expect(field).toBeDefined();
    return field?.name ?? '';
  };

  test('the JSON\'s "name" and "privateKey" go where the adapter reads them', async () => {
    const keyNameField = fieldNamedBy('name');
    const privateKeyField = fieldNamedBy('privateKey');
    expect(keyNameField).not.toBe(privateKeyField);
    expect(coinbaseManifest.credentialFields.map((f) => f.name).sort()).toEqual(
      [keyNameField, privateKeyField].sort()
    );

    const key = throwawayCdpKey();
    const sent = captureFetch(() => Response.json({ data: [] }));
    const result = await new CoinbaseProvider(passthroughLimiter()).validateCredentials(
      { [keyNameField]: key.name, [privateKeyField]: key.privateKeyPem },
      'coinbase'
    );

    expect(result).toEqual({ valid: true });
    const [request] = sent;
    if (!request) throw new Error('no request sent');
    const { claims, signatureValid } = readJwt(request, key.publicKey);
    expect(signatureValid).toBe(true);
    expect(claims.sub).toBe(key.name);
  });
});
