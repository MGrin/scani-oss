import { describe, expect, it, mock } from 'bun:test';
import { BinanceApiService } from './BinanceApiService';

const originalFetch = globalThis.fetch;

describe('BinanceApiService', () => {
  const service = new BinanceApiService('https://api.binance.com');

  describe('validateApiKey', () => {
    it('should return true for valid credentials (200)', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ balances: [] }), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret');
      expect(result).toBe(true);

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v3/account?');
      expect(call![0]).toContain('signature=');
      const headers = call![1]?.headers as Record<string, string>;
      expect(headers).toHaveProperty('X-MBX-APIKEY', 'valid-key');

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

  describe('getSpotBalances', () => {
    it('should call /api/v3/account with signed query and parse balances', async () => {
      const mockResponse = {
        balances: [
          { asset: 'BTC', free: '1.5', locked: '0.5' },
          { asset: 'ETH', free: '10.0', locked: '0.0' },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getSpotBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.asset).toBe('BTC');
      expect(balances[0]!.free).toBe('1.5');
      expect(balances[0]!.locked).toBe('0.5');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v3/account?');
      expect(call![0]).toContain('timestamp=');
      expect(call![0]).toContain('signature=');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ msg: 'Server error' }), { status: 500 }))
      );

      expect(service.getSpotBalances('test-key', 'test-secret')).rejects.toThrow(
        'Failed to fetch spot balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when no balances in response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      );

      const balances = await service.getSpotBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('getMarginBalances', () => {
    it('should call /sapi/v1/margin/account and parse userAssets', async () => {
      const mockResponse = {
        userAssets: [{ asset: 'BTC', free: '0.5', locked: '0.1' }],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getMarginBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(1);
      expect(balances[0]!.asset).toBe('BTC');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/sapi/v1/margin/account?');

      globalThis.fetch = originalFetch;
    });
  });

  describe('getFuturesBalances', () => {
    it('should call /fapi/v2/balance and parse array response', async () => {
      const mockResponse = [
        { asset: 'USDT', availableBalance: '1000', balance: '1500' },
        { asset: 'BNB', availableBalance: '5', balance: '5' },
      ];

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getFuturesBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.asset).toBe('USDT');
      expect(balances[0]!.free).toBe('1000');
      expect(balances[0]!.locked).toBe('500');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/fapi/v2/balance?');

      globalThis.fetch = originalFetch;
    });
  });
});
