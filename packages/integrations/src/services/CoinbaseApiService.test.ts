import { describe, expect, it, mock } from 'bun:test';
import { CoinbaseApiService } from './CoinbaseApiService';

const originalFetch = globalThis.fetch;

describe('CoinbaseApiService', () => {
  const service = new CoinbaseApiService('https://api.coinbase.com');

  describe('getBalances', () => {
    it('should call /v2/accounts with correct auth headers and parse response', async () => {
      const mockResponse = {
        data: [
          {
            id: 'acc-1',
            name: 'BTC Wallet',
            type: 'wallet',
            currency: { code: 'BTC', name: 'Bitcoin' },
            balance: { amount: '1.5', currency: 'BTC' },
          },
          {
            id: 'acc-2',
            name: 'ETH Wallet',
            type: 'wallet',
            currency: { code: 'ETH', name: 'Ethereum' },
            balance: { amount: '10.0', currency: 'ETH' },
          },
        ],
        pagination: { next_uri: null },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.currency).toBe('BTC');
      expect(balances[0]!.balance).toBe('1.5');
      expect(balances[0]!.name).toBe('BTC Wallet');
      expect(balances[0]!.type).toBe('wallet');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/v2/accounts?limit=100');
      const headers = call![1]?.headers as Record<string, string>;
      expect(headers).toHaveProperty('CB-ACCESS-KEY', 'test-key');
      expect(headers).toHaveProperty('CB-ACCESS-SIGN');
      expect(headers).toHaveProperty('CB-ACCESS-TIMESTAMP');
      expect(headers).toHaveProperty('CB-VERSION', '2024-01-01');

      globalThis.fetch = originalFetch;
    });

    it('should handle pagination', async () => {
      const page1 = {
        data: [
          {
            id: 'acc-1',
            name: 'BTC Wallet',
            type: 'wallet',
            currency: { code: 'BTC', name: 'Bitcoin' },
            balance: { amount: '1.0', currency: 'BTC' },
          },
        ],
        pagination: { next_uri: '/v2/accounts?limit=100&starting_after=acc-1' },
      };
      const page2 = {
        data: [
          {
            id: 'acc-2',
            name: 'ETH Wallet',
            type: 'wallet',
            currency: { code: 'ETH', name: 'Ethereum' },
            balance: { amount: '5.0', currency: 'ETH' },
          },
        ],
        pagination: { next_uri: null },
      };

      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        const response = callCount === 1 ? page1 : page2;
        return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
      });

      const balances = await service.getBalances('test-key', 'test-secret');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.currency).toBe('BTC');
      expect(balances[1]!.currency).toBe('ETH');
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

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
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (200 OK)', async () => {
      const mockResponse = {
        data: [{ id: 'acc-1' }],
        pagination: { next_uri: null },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret');
      expect(result).toBe(true);

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/v2/accounts?limit=1');

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
