import { describe, expect, it, mock } from 'bun:test';
import { WiseApiService } from './WiseApiService';

// Mock fetch globally
const originalFetch = globalThis.fetch;

describe('WiseApiService', () => {
  const service = new WiseApiService();

  describe('getProfiles', () => {
    it('should call /v2/profiles with Bearer token', async () => {
      const mockProfiles = [
        { id: 123, type: 'PERSONAL', fullName: 'Test User' },
        { id: 456, type: 'BUSINESS', fullName: 'Test Business' },
      ];

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockProfiles), { status: 200 }))
      );

      const profiles = await service.getProfiles('test-token');
      expect(profiles).toHaveLength(2);
      expect(profiles[0]!.type).toBe('PERSONAL');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/v2/profiles');
      expect(call![1]?.headers).toHaveProperty('Authorization', 'Bearer test-token');

      globalThis.fetch = originalFetch;
    });
  });

  describe('getBalances', () => {
    it('should call /v4/profiles/{id}/balances with correct URL', async () => {
      const mockBalances = [
        { id: 1, currency: 'EUR', amount: { value: 1500.5, currency: 'EUR' } },
        { id: 2, currency: 'USD', amount: { value: 200.0, currency: 'USD' } },
      ];

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify(mockBalances), { status: 200 }))
      );

      const balances = await service.getBalances('test-token', 123);
      expect(balances).toHaveLength(2);
      expect(balances[0]!.currency).toBe('EUR');

      const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(call![0]).toContain('/v4/profiles/123/balances');

      globalThis.fetch = originalFetch;
    });
  });

  describe('validateApiToken', () => {
    it('should return true for valid token', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify([{ id: 1 }]), { status: 200 }))
      );

      const result = await service.validateApiToken('valid-token');
      expect(result).toBe(true);
      globalThis.fetch = originalFetch;
    });

    it('should throw for invalid token (401)', async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

      await expect(service.validateApiToken('bad-token')).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });

    it('should throw on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

      await expect(service.validateApiToken('any-token')).rejects.toThrow();
      globalThis.fetch = originalFetch;
    });
  });
});
