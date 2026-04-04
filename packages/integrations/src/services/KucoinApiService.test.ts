import { describe, expect, it, mock } from 'bun:test';
import { KucoinApiService } from './KucoinApiService';

const originalFetch = globalThis.fetch;

describe('KucoinApiService', () => {
  const service = new KucoinApiService('https://api.kucoin.com');

  describe('getBalances', () => {
    it('should call /api/v1/accounts with correct auth headers and parse response', async () => {
      const mockResponse = {
        code: '200000',
        data: [
          {
            id: '1',
            currency: 'BTC',
            type: 'trade',
            balance: '1.5',
            available: '1.0',
            holds: '0.5',
          },
          {
            id: '2',
            currency: 'USDT',
            type: 'main',
            balance: '5000',
            available: '5000',
            holds: '0',
          },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret', 'test-passphrase');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.currency).toBe('BTC');
      expect(balances[0]!.balance).toBe('1.5');
      expect(balances[0]!.type).toBe('trade');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v1/accounts');
      const options = call![1] as RequestInit;
      expect(options.method).toBe('GET');
      const headers = options.headers as Record<string, string>;
      expect(headers).toHaveProperty('KC-API-KEY', 'test-key');
      expect(headers).toHaveProperty('KC-API-SIGN');
      expect(headers).toHaveProperty('KC-API-TIMESTAMP');
      expect(headers).toHaveProperty('KC-API-PASSPHRASE');
      expect(headers).toHaveProperty('KC-API-KEY-VERSION', '2');
      expect(headers).toHaveProperty('Content-Type', 'application/json');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 500 }))
      );

      expect(service.getBalances('test-key', 'test-secret', 'test-passphrase')).rejects.toThrow(
        'Failed to fetch balances'
      );

      globalThis.fetch = originalFetch;
    });

    it('should throw when KuCoin returns non-200000 code', async () => {
      const mockResponse = {
        code: '400003',
        msg: 'KC-API-KEY not exists',
        data: null,
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      expect(service.getBalances('test-key', 'test-secret', 'test-passphrase')).rejects.toThrow(
        'KuCoin API error'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when data is null', async () => {
      const mockResponse = {
        code: '200000',
        data: null,
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret', 'test-passphrase');
      expect(balances).toHaveLength(0);

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiKey', () => {
    it('should return true for valid credentials (code 200000)', async () => {
      const mockResponse = {
        code: '200000',
        data: [],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret', 'valid-passphrase');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should return false for invalid credentials (401)', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      const result = await service.validateApiKey('bad-key', 'bad-secret', 'bad-passphrase');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should return false on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await service.validateApiKey('any-key', 'any-secret', 'any-passphrase');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });
  });
});
