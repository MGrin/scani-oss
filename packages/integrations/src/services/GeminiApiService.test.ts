import { describe, expect, it, mock } from 'bun:test';
import { GeminiApiService } from './GeminiApiService';

const originalFetch = globalThis.fetch;

describe('GeminiApiService', () => {
  const service = new GeminiApiService('https://api.gemini.com');

  describe('getBalances', () => {
    it('should POST to /v1/balances with correct auth headers and parse response', async () => {
      const mockResponse = [
        {
          currency: 'BTC',
          amount: '1.5',
          available: '1.0',
          availableForWithdrawal: '1.0',
          type: 'exchange',
        },
        {
          currency: 'ETH',
          amount: '10.0',
          available: '10.0',
          availableForWithdrawal: '10.0',
          type: 'exchange',
        },
      ];

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.currency).toBe('BTC');
      expect(balances[0]!.amount).toBe('1.5');
      expect(balances[0]!.type).toBe('exchange');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/v1/balances');
      const options = call![1] as RequestInit;
      expect(options.method).toBe('POST');
      const headers = options.headers as Record<string, string>;
      expect(headers).toHaveProperty('X-GEMINI-APIKEY', 'test-key');
      expect(headers).toHaveProperty('X-GEMINI-PAYLOAD');
      expect(headers).toHaveProperty('X-GEMINI-SIGNATURE');
      expect(headers).toHaveProperty('Content-Type', 'text/plain');
      expect(headers).toHaveProperty('Content-Length', '0');

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

    it('should return empty array when response is not an array', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'something' }), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (200 OK)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
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

    it('should return false on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await service.validateApiKey('any-key', 'any-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });
  });
});
