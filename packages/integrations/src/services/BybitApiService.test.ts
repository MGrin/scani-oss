import { describe, expect, it, mock } from 'bun:test';
import { BybitApiService } from './BybitApiService';

const originalFetch = globalThis.fetch;

describe('BybitApiService', () => {
  const service = new BybitApiService('https://api.bybit.com');

  describe('getBalances', () => {
    it('should call /v5/account/wallet-balance with correct auth headers and parse response', async () => {
      const mockResponse = {
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [
            {
              accountType: 'UNIFIED',
              coin: [
                { coin: 'BTC', walletBalance: '1.5', usdValue: '45000' },
                { coin: 'ETH', walletBalance: '10.0', usdValue: '20000' },
              ],
            },
          ],
        },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.coin).toBe('BTC');
      expect(balances[0]!.walletBalance).toBe('1.5');
      expect(balances[1]!.coin).toBe('ETH');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/v5/account/wallet-balance?accountType=UNIFIED');
      const headers = call![1]?.headers as Record<string, string>;
      expect(headers).toHaveProperty('X-BAPI-API-KEY', 'test-key');
      expect(headers).toHaveProperty('X-BAPI-SIGN');
      expect(headers).toHaveProperty('X-BAPI-TIMESTAMP');
      expect(headers).toHaveProperty('X-BAPI-RECV-WINDOW', '5000');

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

    it('should throw on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      expect(service.getBalances('test-key', 'test-secret')).rejects.toThrow(
        'Failed to fetch balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when no coins in response', async () => {
      const mockResponse = {
        retCode: 0,
        retMsg: 'OK',
        result: { list: [{ accountType: 'UNIFIED', coin: [] }] },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (retCode 0)', async () => {
      const mockResponse = {
        retCode: 0,
        retMsg: 'OK',
        result: { list: [] },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
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

    it('should return false when retCode is non-zero', async () => {
      const mockResponse = {
        retCode: 10003,
        retMsg: 'Invalid API key',
        result: { list: [] },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateApiKey('bad-key', 'bad-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });
  });
});
