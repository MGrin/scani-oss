import { describe, expect, it, mock } from 'bun:test';
import { BitgetApiService } from './BitgetApiService';

const originalFetch = globalThis.fetch;

describe('BitgetApiService', () => {
  const service = new BitgetApiService('https://api.bitget.com');

  describe('getBalances', () => {
    it('should call /api/v2/spot/account/assets with correct auth headers and parse response', async () => {
      const mockResponse = {
        code: '00000',
        msg: 'success',
        data: [
          { coin: 'BTC', available: '1.5', frozen: '0.1', locked: '0.0' },
          { coin: 'USDT', available: '5000', frozen: '0', locked: '0' },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalances('test-key', 'test-secret', 'test-passphrase');
      expect(balances).toHaveLength(2);
      expect(balances[0]!.coin).toBe('BTC');
      expect(balances[0]!.available).toBe('1.5');
      expect(balances[0]!.frozen).toBe('0.1');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/api/v2/spot/account/assets');
      const headers = call![1]?.headers as Record<string, string>;
      expect(headers).toHaveProperty('ACCESS-KEY', 'test-key');
      expect(headers).toHaveProperty('ACCESS-SIGN');
      expect(headers).toHaveProperty('ACCESS-TIMESTAMP');
      expect(headers).toHaveProperty('ACCESS-PASSPHRASE', 'test-passphrase');
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

    it('should throw when Bitget returns non-00000 code', async () => {
      const mockResponse = {
        code: '40014',
        msg: 'Invalid API Key',
        data: [],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      expect(service.getBalances('test-key', 'test-secret', 'test-passphrase')).rejects.toThrow(
        'Bitget API error'
      );

      globalThis.fetch = originalFetch;
    });

    it('should return empty array when data is null', async () => {
      const mockResponse = {
        code: '00000',
        msg: 'success',
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
    it('should return true for valid credentials (code 00000)', async () => {
      const mockResponse = {
        code: '00000',
        msg: 'success',
        data: [],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateApiKey('valid-key', 'valid-secret', 'valid-passphrase');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should throw for invalid credentials (401)', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      await expect(
        service.validateApiKey('bad-key', 'bad-secret', 'bad-passphrase')
      ).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });

    it('should throw on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      await expect(
        service.validateApiKey('any-key', 'any-secret', 'any-passphrase')
      ).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });
  });
});
