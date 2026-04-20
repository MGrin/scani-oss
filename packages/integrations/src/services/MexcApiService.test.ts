import { describe, expect, it, mock } from 'bun:test';
import { MexcApiService } from './MexcApiService';

const originalFetch = globalThis.fetch;

describe('MexcApiService', () => {
  const service = new MexcApiService('https://api.mexc.com');

  describe('getBalances', () => {
    it('should call /api/v3/account with signed query and parse balances', async () => {
      const mockResponse = {
        balances: [
          { asset: 'BTC', free: '1.5', locked: '0.5' },
          { asset: 'USDT', free: '5000', locked: '0' },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.asset).toBe('BTC');
      expect(balances[0]!.free).toBe('1.5');
      expect(balances[0]!.locked).toBe('0.5');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v3/account?');
      expect(call![0]).toContain('timestamp=');
      expect(call![0]).toContain('signature=');
      const headers = call![1]?.headers as Record<string, string>;
      expect(headers).toHaveProperty('X-MEXC-APIKEY', 'test-key');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ msg: 'Server error' }), { status: 500 }))
      );

      expect(service.getBalances('test-key', 'test-secret')).rejects.toThrow(
        'Failed to fetch balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when no balances in response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (200)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ balances: [] }), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret');
      expect(result).toBe(true);

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v3/account?');

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
  });
});
