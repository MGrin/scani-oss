import { describe, expect, it, mock } from 'bun:test';
import { GateioApiService } from './GateioApiService';

const originalFetch = globalThis.fetch;

describe('GateioApiService', () => {
  const service = new GateioApiService('https://api.gateio.ws/api/v4');

  describe('getBalances', () => {
    it('should call /spot/accounts with correct auth headers and parse response', async () => {
      const mockResponse = [
        { currency: 'BTC', available: '1.5', locked: '0.1' },
        { currency: 'USDT', available: '5000', locked: '0' },
      ];

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.currency).toBe('BTC');
      expect(balances[0]!.available).toBe('1.5');
      expect(balances[0]!.locked).toBe('0.1');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/spot/accounts');
      const options = call![1] as RequestInit;
      expect(options.method).toBe('GET');
      const headers = options.headers as Record<string, string>;
      expect(headers).toHaveProperty('KEY', 'test-key');
      expect(headers).toHaveProperty('SIGN');
      expect(headers).toHaveProperty('Timestamp');
      expect(headers).toHaveProperty('Content-Type', 'application/json');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ message: 'Server error' }), { status: 500 }))
      );

      expect(service.getBalances('test-key', 'test-secret')).rejects.toThrow(
        'Failed to fetch balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when response is not an array', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (200 + array response)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should return false for 401 response', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      const result = await service.validateApiKey('bad-key', 'bad-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should return false for 403 response', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Forbidden', { status: 403 })));

      const result = await service.validateApiKey('bad-key', 'bad-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should throw on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      await expect(service.validateApiKey('any-key', 'any-secret')).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });

    it('should throw when response is not an array', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ label: 'not array' }), { status: 200 }))
      );

      await expect(service.validateApiKey('test-key', 'test-secret')).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });
  });
});
