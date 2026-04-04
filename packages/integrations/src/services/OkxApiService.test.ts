import { describe, expect, it, mock } from 'bun:test';
import { OkxApiService } from './OkxApiService';

const originalFetch = globalThis.fetch;

describe('OkxApiService', () => {
  const service = new OkxApiService('https://www.okx.com');

  describe('getBalances', () => {
    it('should call /api/v5/account/balance with correct auth headers and parse response', async () => {
      const mockResponse = {
        code: '0',
        msg: '',
        data: [
          {
            totalEq: '65000',
            details: [
              { ccy: 'BTC', cashBal: '1.5', eqUsd: '45000' },
              { ccy: 'USDT', cashBal: '20000', eqUsd: '20000' },
            ],
          },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret', 'test-passphrase');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.ccy).toBe('BTC');
      expect(balances[0]!.cashBal).toBe('1.5');
      expect(balances[1]!.ccy).toBe('USDT');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v5/account/balance');
      const headers = call![1]?.headers as Record<string, string>;
      expect(headers).toHaveProperty('OK-ACCESS-KEY', 'test-key');
      expect(headers).toHaveProperty('OK-ACCESS-SIGN');
      expect(headers).toHaveProperty('OK-ACCESS-TIMESTAMP');
      expect(headers).toHaveProperty('OK-ACCESS-PASSPHRASE', 'test-passphrase');

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

    it('should throw when OKX returns non-zero code', async () => {
      const mockResponse = {
        code: '50111',
        msg: 'Invalid API key',
        data: [],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      expect(service.getBalances('test-key', 'test-secret', 'test-passphrase')).rejects.toThrow(
        'OKX API error'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when no details in response', async () => {
      const mockResponse = {
        code: '0',
        msg: '',
        data: [{ totalEq: '0', details: [] }],
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
    it('should return true for valid credentials (code 0)', async () => {
      const mockResponse = {
        code: '0',
        msg: '',
        data: [{ totalEq: '0', details: [] }],
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
