import { describe, expect, it, mock } from 'bun:test';
import { BitstampApiService } from './BitstampApiService';

const originalFetch = globalThis.fetch;

describe('BitstampApiService', () => {
  const service = new BitstampApiService('https://www.bitstamp.net');

  describe('getBalances', () => {
    it('should POST to /balance/ with correct auth headers and parse {currency}_balance keys', async () => {
      const mockResponse = {
        btc_balance: '1.50000000',
        btc_available: '1.00000000',
        btc_reserved: '0.50000000',
        usd_balance: '5000.00',
        usd_available: '4500.00',
        usd_reserved: '500.00',
        eth_balance: '10.00000000',
        eth_available: '10.00000000',
        eth_reserved: '0.00000000',
        fee: '0.25',
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(3);
      const currencies = balances.map((b) => b.currency);
      expect(currencies).toContain('btc');
      expect(currencies).toContain('usd');
      expect(currencies).toContain('eth');

      const btc = balances.find((b) => b.currency === 'btc');
      expect(btc!.balance).toBe('1.50000000');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/balance/');
      const options = call![1] as RequestInit;
      expect(options.method).toBe('POST');
      const headers = options.headers as Record<string, string>;
      expect(headers['X-Auth']).toContain('BITSTAMP test-key');
      expect(headers).toHaveProperty('X-Auth-Signature');
      expect(headers).toHaveProperty('X-Auth-Nonce');
      expect(headers).toHaveProperty('X-Auth-Timestamp');
      expect(headers).toHaveProperty('X-Auth-Version', 'v2');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 500 }))
      );

      expect(service.getBalances('test-key', 'test-secret')).rejects.toThrow(
        'Failed to fetch balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when response has no _balance keys', async () => {
      const mockResponse = { fee: '0.25', status: 'active' };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (200 OK)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ btc_balance: '0' }), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should return false for invalid credentials (401)', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      const result = await service.validateApiKey('bad-key', 'bad-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should throw on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      await expect(service.validateApiKey('any-key', 'any-secret')).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });
  });
});
