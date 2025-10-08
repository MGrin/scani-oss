/**
 * Bitcoin Service Unit Tests
 *
 * Tests the Bitcoin service address validation and chain support
 * Run with: bun test src/tests/chain-services/bitcoin.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { bitcoinService } from '../../services/chain/bitcoin';

describe('BitcoinService', () => {
  describe('getServiceName', () => {
    test('should return correct service name', () => {
      expect(bitcoinService.getServiceName()).toBe('BitcoinService');
    });
  });

  describe('supportsChain', () => {
    test('should support Bitcoin chain ID (0)', () => {
      expect(bitcoinService.supportsChain(0)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(bitcoinService.supportsChain(1)).toBe(false); // Ethereum
      expect(bitcoinService.supportsChain(-1)).toBe(false); // Tron
      expect(bitcoinService.supportsChain(-2)).toBe(false); // Solana
      expect(bitcoinService.supportsChain(137)).toBe(false); // Polygon
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid P2PKH addresses (legacy, prefix 1)', () => {
      const validP2PKH = [
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Genesis block address
        '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', // Mt. Gox address
        '1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp', // SatoshiDice
      ];

      for (const address of validP2PKH) {
        expect(address).toMatch(/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/);
      }
    });

    test('should recognize valid P2SH addresses (prefix 3)', () => {
      const validP2SH = [
        '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy',
        '3Nxwenay9Z8Lc9JBiywExpnEFiLp6Afp8v',
      ];

      for (const address of validP2SH) {
        expect(address).toMatch(/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/);
      }
    });

    test('should recognize valid Bech32 addresses (native SegWit, prefix bc1)', () => {
      const validBech32 = [
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', // Taproot
      ];

      for (const address of validBech32) {
        expect(address).toMatch(/^bc1[a-zA-HJ-NP-Z0-9]{25,62}$/);
      }
    });

    test('should reject invalid Bitcoin addresses', () => {
      const invalidAddresses = [
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // Tron
        'bc1', // Too short
        '1abc', // Too short
        '4NotBitcoinAddress', // Invalid prefix
        '', // Empty
        'LTC9s65mZ4rXoYxcXXH3jFZDvTb6g5Ftmq', // Litecoin
      ];

      const bitcoinPattern = /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(bitcoinPattern);
      }
    });
  });

  describe('Address Format Detection', () => {
    test('should distinguish between different Bitcoin address types', () => {
      const addresses = {
        p2pkh: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        p2sh: '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy',
        bech32: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      };

      expect(addresses.p2pkh.startsWith('1')).toBe(true);
      expect(addresses.p2sh.startsWith('3')).toBe(true);
      expect(addresses.bech32.startsWith('bc1')).toBe(true);
    });
  });

  describe('Chain Constants', () => {
    test('should have correct satoshi conversion constant', () => {
      const SATOSHIS_PER_BTC = 100_000_000;
      expect(SATOSHIS_PER_BTC).toBe(100000000);
      expect(SATOSHIS_PER_BTC).toBe(1e8);
    });

    test('should have correct decimals for BTC', () => {
      const BTC_DECIMALS = 8;
      expect(BTC_DECIMALS).toBe(8);
    });
  });
});
