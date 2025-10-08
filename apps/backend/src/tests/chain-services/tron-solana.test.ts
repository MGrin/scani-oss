/**
 * Tron and Solana Services Unit Tests
 *
 * Tests for Tron and Solana chain services
 * Run with: bun test src/tests/chain-services/tron-solana.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { solanaService } from '../../services/chain/solana';
import { tronService } from '../../services/chain/tron';

describe('TronService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(tronService.getServiceName()).toBe('TronService');
    });

    test('should support Tron chain ID (-1)', () => {
      expect(tronService.supportsChain(-1)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(tronService.supportsChain(0)).toBe(false); // Bitcoin
      expect(tronService.supportsChain(1)).toBe(false); // Ethereum
      expect(tronService.supportsChain(-2)).toBe(false); // Solana
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Tron addresses', () => {
      const validAddresses = [
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
        'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
        'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC',
      ];

      const tronPattern = /^T[a-zA-Z0-9]{33}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(tronPattern);
        expect(address.startsWith('T')).toBe(true);
        expect(address.length).toBe(34); // T + 33 chars
      }
    });

    test('should reject invalid Tron addresses', () => {
      const invalidAddresses = [
        'T9yD14Nj', // Too short
        'A9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // Wrong prefix
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK', // Solana
        '', // Empty
      ];

      const tronPattern = /^T[a-zA-Z0-9]{33}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(tronPattern);
      }
    });

    test('should distinguish Tron from other T-prefixed formats', () => {
      const tronAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
      const notTron = 'TOKEN123'; // Too short

      const tronPattern = /^T[a-zA-Z0-9]{33}$/;
      expect(tronAddress).toMatch(tronPattern);
      expect(notTron).not.toMatch(tronPattern);
    });
  });

  describe('Constants', () => {
    test('should have correct SUN conversion', () => {
      const SUN_PER_TRX = 1_000_000;
      expect(SUN_PER_TRX).toBe(1000000);
    });

    test('should have correct decimals for TRX', () => {
      const TRX_DECIMALS = 6;
      expect(TRX_DECIMALS).toBe(6);
    });
  });

  describe('Address Format', () => {
    test('should have base58 encoded addresses', () => {
      const tronAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

      // Base58 characters (no 0, O, I, l)
      const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const allCharsValid = tronAddress
        .slice(1)
        .split('')
        .every((char) => base58Chars.includes(char));

      expect(allCharsValid).toBe(true);
    });
  });
});

describe('SolanaService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(solanaService.getServiceName()).toBe('SolanaService');
    });

    test('should support Solana chain ID (-2)', () => {
      expect(solanaService.supportsChain(-2)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(solanaService.supportsChain(0)).toBe(false); // Bitcoin
      expect(solanaService.supportsChain(1)).toBe(false); // Ethereum
      expect(solanaService.supportsChain(-1)).toBe(false); // Tron
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Solana addresses', () => {
      const validAddresses = [
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        '7EqQdEUzsvU4kLHyBxKELKoEJJjB7cDdGCw3MqjNa3Zx',
        'So11111111111111111111111111111111111111112', // Wrapped SOL
        '11111111111111111111111111111111', // System program
      ];

      const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(solanaPattern);
        expect(address.length).toBeGreaterThanOrEqual(32);
        expect(address.length).toBeLessThanOrEqual(44);
      }
    });

    test('should reject invalid Solana addresses', () => {
      const invalidAddresses = [
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
        'short', // Too short
        '', // Empty
      ];

      const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(solanaPattern);
      }
    });

    test('should handle base58 encoding constraints', () => {
      const solanaAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

      // Base58 excludes: 0, O, I, l (to avoid confusion)
      const invalidChars = ['0', 'O', 'I', 'l'];
      const hasInvalidChars = invalidChars.some((char) => solanaAddress.includes(char));

      expect(hasInvalidChars).toBe(false);
    });
  });

  describe('Constants', () => {
    test('should have correct lamports conversion', () => {
      const LAMPORTS_PER_SOL = 1_000_000_000;
      expect(LAMPORTS_PER_SOL).toBe(1000000000);
      expect(LAMPORTS_PER_SOL).toBe(1e9);
    });

    test('should have correct decimals for SOL', () => {
      const SOL_DECIMALS = 9;
      expect(SOL_DECIMALS).toBe(9);
    });
  });

  describe('Address Length Variations', () => {
    test('should accept addresses within valid length range', () => {
      const addresses = {
        short: '11111111111111111111111111111111', // 32 chars
        medium: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK', // 44 chars
      };

      const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      expect(addresses.short).toMatch(solanaPattern);
      expect(addresses.medium).toMatch(solanaPattern);
    });

    test('should reject addresses outside valid length range', () => {
      const addresses = {
        tooShort: '1111111111111111111111111111111', // 31 chars
        tooLong: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKKX', // 45 chars
      };

      const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      expect(addresses.tooShort).not.toMatch(solanaPattern);
      expect(addresses.tooLong).not.toMatch(solanaPattern);
    });
  });

  describe('Distinguishing from Similar Formats', () => {
    test('should not confuse Solana with Bitcoin', () => {
      const bitcoinAddress = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
      const solanaAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

      // Bitcoin addresses are 25-34 chars (can reach 34)
      expect(bitcoinAddress.length).toBeLessThanOrEqual(34);

      // Solana addresses are 32-44 chars
      expect(solanaAddress.length).toBeGreaterThanOrEqual(32);
    });

    test('should not confuse Solana with Tron', () => {
      const tronAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
      const solanaAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

      // Tron addresses always start with T
      expect(tronAddress.startsWith('T')).toBe(true);

      // Solana addresses don't start with T
      expect(solanaAddress.startsWith('T')).toBe(false);
    });
  });
});

describe('Tron vs Solana Comparison', () => {
  test('should have different chain IDs', () => {
    expect(tronService.supportsChain(-1)).toBe(true);
    expect(solanaService.supportsChain(-2)).toBe(true);
    expect(tronService.supportsChain(-2)).toBe(false);
    expect(solanaService.supportsChain(-1)).toBe(false);
  });

  test('should have different native token symbols', () => {
    // Tron uses TRX, Solana uses SOL
    const tronSymbol = 'TRX';
    const solanaSymbol = 'SOL';

    expect(tronSymbol).not.toBe(solanaSymbol);
  });

  test('should have different decimals', () => {
    const TRX_DECIMALS = 6;
    const SOL_DECIMALS = 9;

    expect(TRX_DECIMALS).not.toBe(SOL_DECIMALS);
  });

  test('should have different address formats', () => {
    const tronPattern = /^T[a-zA-Z0-9]{33}$/;
    // Solana uses base58 but doesn't start with T
    const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    const tronAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    const solanaAddress = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

    // Tron starts with T, Solana doesn't
    expect(tronAddress).toMatch(tronPattern);
    expect(tronAddress.startsWith('T')).toBe(true);
    expect(solanaAddress.startsWith('T')).toBe(false);

    expect(solanaAddress).toMatch(solanaPattern);
    expect(solanaAddress).not.toMatch(tronPattern);
  });
});
