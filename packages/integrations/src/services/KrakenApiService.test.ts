import { describe, expect, it, mock } from 'bun:test';
import { KrakenApiService } from './KrakenApiService';

const originalFetch = globalThis.fetch;

describe('KrakenApiService', () => {
  const service = new KrakenApiService('https://api.kraken.com');

  describe('getBalances', () => {
    it('should POST to /0/private/Balance with correct auth headers and parse response', async () => {
      const mockResponse = {
        error: [],
        result: {
          XXBT: '1.5000000000',
          XETH: '10.0000000000',
          ZUSD: '5000.0000',
        },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'dGVzdC1zZWNyZXQ=');
      expect(balances).toHaveLength(3);
      expect(balances[0]!.asset).toBe('XXBT');
      expect(balances[0]!.balance).toBe('1.5000000000');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/0/private/Balance');
      const options = call![1] as RequestInit;
      expect(options.method).toBe('POST');
      const headers = options.headers as Record<string, string>;
      expect(headers).toHaveProperty('API-Key', 'test-key');
      expect(headers).toHaveProperty('API-Sign');
      expect(headers).toHaveProperty('Content-Type', 'application/x-www-form-urlencoded');
      expect(options.body).toContain('nonce=');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 500 }))
      );

      expect(service.getBalances('test-key', 'dGVzdC1zZWNyZXQ=')).rejects.toThrow(
        'Failed to fetch balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should throw when Kraken returns error array', async () => {
      const mockResponse = {
        error: ['EAPI:Invalid key'],
        result: {},
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      expect(service.getBalances('test-key', 'dGVzdC1zZWNyZXQ=')).rejects.toThrow(
        'Kraken API error'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when result is empty', async () => {
      const mockResponse = {
        error: [],
        result: {},
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'dGVzdC1zZWNyZXQ=');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (empty error array)', async () => {
      const mockResponse = {
        error: [],
        result: { XXBT: '0' },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'dGVzdC1zZWNyZXQ=');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should return false for invalid credentials (401)', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      const result = await service.validateApiKey('bad-key', 'dGVzdC1zZWNyZXQ=');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should return false when error array is non-empty', async () => {
      const mockResponse = {
        error: ['EAPI:Invalid key'],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateApiKey('bad-key', 'dGVzdC1zZWNyZXQ=');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should return false on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await service.validateApiKey('any-key', 'dGVzdC1zZWNyZXQ=');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });
  });
});
