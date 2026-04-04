import { describe, expect, it, mock } from 'bun:test';
import { HuobiApiService } from './HuobiApiService';

const originalFetch = globalThis.fetch;

describe('HuobiApiService', () => {
  const service = new HuobiApiService('https://api.huobi.pro');

  describe('getAccounts', () => {
    it('should call /v1/account/accounts with signed query params and parse response', async () => {
      const mockResponse = {
        status: 'ok',
        data: [
          { id: 12345, type: 'spot', state: 'working' },
          { id: 12346, type: 'margin', state: 'working' },
        ],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const accounts = await service.getAccounts('test-key', 'test-secret');
      expect(accounts).toHaveLength(2);
      expect(accounts[0]!.id).toBe(12345);
      expect(accounts[0]!.type).toBe('spot');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      const url = call![0] as string;
      expect(url).toContain('/v1/account/accounts?');
      expect(url).toContain('AccessKeyId=test-key');
      expect(url).toContain('SignatureMethod=HmacSHA256');
      expect(url).toContain('SignatureVersion=2');
      expect(url).toContain('Signature=');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP 500 error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 500 }))
      );

      expect(service.getAccounts('test-key', 'test-secret')).rejects.toThrow('Huobi API error');

      globalThis.fetch = originalFetch;
    });

    it('should throw when Huobi returns non-ok status', async () => {
      const mockResponse = {
        status: 'error',
        'err-code': 'api-signature-not-valid',
        'err-msg': 'Signature not valid',
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      expect(service.getAccounts('test-key', 'test-secret')).rejects.toThrow('Huobi API error');

      globalThis.fetch = originalFetch;
    });
  });

  describe('getBalance', () => {
    it('should call /v1/account/accounts/{id}/balance and parse balance list', async () => {
      const mockResponse = {
        status: 'ok',
        data: {
          id: 12345,
          type: 'spot',
          state: 'working',
          list: [
            { currency: 'btc', type: 'trade', balance: '1.5' },
            { currency: 'usdt', type: 'trade', balance: '5000' },
            { currency: 'eth', type: 'frozen', balance: '0.5' },
          ],
        },
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const balances = await service.getBalance('test-key', 'test-secret', 12345);
      expect(balances).toHaveLength(3);
      expect(balances[0]!.currency).toBe('btc');
      expect(balances[0]!.type).toBe('trade');
      expect(balances[0]!.balance).toBe('1.5');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      const url = call![0] as string;
      expect(url).toContain('/v1/account/accounts/12345/balance?');

      globalThis.fetch = originalFetch;
    });

    it('should throw on HTTP error', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));

      expect(service.getBalance('test-key', 'test-secret', 99999)).rejects.toThrow(
        'Huobi balance API error'
      );

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateCredentials', () => {
    it('should return true when getAccounts returns accounts', async () => {
      const mockResponse = {
        status: 'ok',
        data: [{ id: 12345, type: 'spot', state: 'working' }],
      };

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
      );

      const result = await service.validateCredentials('valid-key', 'valid-secret');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should return false for invalid credentials (HTTP error)', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      const result = await service.validateCredentials('bad-key', 'bad-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });

    it('should return false on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      const result = await service.validateCredentials('any-key', 'any-secret');
      expect(result).toBe(false);
      globalThis.fetch = originalFetch;
    });
  });
});
