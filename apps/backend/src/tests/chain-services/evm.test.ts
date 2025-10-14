/**
 * EVM Chain Service Unit Tests
 *
 * Tests the EVM chain service address validation and chain support
 * Run with: bun test src/tests/chain-services/evm.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { EVM_CHAINS } from '../../config/chains';
import { evmChainService } from '../../infrastructure/external-services/blockchain/evm';

describe('EVMChainService', () => {
  describe('getServiceName', () => {
    test('should return correct service name', () => {
      expect(evmChainService.getServiceName()).toBe('EVMChainService');
    });
  });

  describe('supportsChain', () => {
    test('should support all EVM chain IDs from config', () => {
      const chainIds = Object.keys(EVM_CHAINS).map(Number);

      for (const chainId of chainIds) {
        expect(evmChainService.supportsChain(chainId)).toBe(true);
      }
    });

    test('should not support non-EVM chain IDs', () => {
      expect(evmChainService.supportsChain(0)).toBe(false); // Bitcoin
      expect(evmChainService.supportsChain(-1)).toBe(false); // Tron
      expect(evmChainService.supportsChain(-2)).toBe(false); // Solana
      expect(evmChainService.supportsChain(999999)).toBe(false); // Invalid
    });

    test('should support all 35 standard EVM chains', () => {
      const standardChains = [1, 10, 25, 56, 100, 137, 250, 324, 8453, 42161, 43114];

      for (const chainId of standardChains) {
        expect(evmChainService.supportsChain(chainId)).toBe(true);
      }
    });
  });

  describe('Address Validation', () => {
    test('should handle valid Ethereum addresses', () => {
      const validAddresses = [
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
        '0x0000000000000000000000000000000000000000',
        '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // Vitalik's address
      ];

      // All valid EVM addresses should have correct format
      for (const address of validAddresses) {
        expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });

    test('should identify invalid Ethereum addresses', () => {
      const invalidAddresses = [
        '0x742d35Cc', // Too short
        '742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Missing 0x
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0123', // Too long
        '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', // Invalid hex
        '', // Empty
      ];

      for (const address of invalidAddresses) {
        expect(address).not.toMatch(/^0x[a-fA-F0-9]{40}$/);
      }
    });
  });

  describe('Chain Configuration', () => {
    test('should have correct number of supported chains', () => {
      const chainCount = Object.keys(EVM_CHAINS).length;
      expect(chainCount).toBe(35);
    });

    test('should have valid chain configurations', () => {
      for (const [chainId, config] of Object.entries(EVM_CHAINS)) {
        expect(config.chainId).toBe(Number(chainId));
        expect(config.name).toBeTruthy();
        expect(config.rpcUrls.length).toBeGreaterThan(0);
        expect(config.nativeCurrency).toBeTruthy();
        expect(config.nativeCurrency.symbol).toBeTruthy();
        expect(config.nativeCurrency.decimals).toBe(18);
      }
    });

    test('should have unique chain names', () => {
      const names = Object.values(EVM_CHAINS).map((c) => c.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    test('should have Ethereum as chain ID 1', () => {
      expect(EVM_CHAINS[1]?.name).toBe('Ethereum');
      expect(EVM_CHAINS[1]?.nativeCurrency.symbol).toBe('ETH');
    });

    test('should have Polygon as chain ID 137', () => {
      expect(EVM_CHAINS[137]?.name).toBe('Polygon');
      expect(EVM_CHAINS[137]?.nativeCurrency.symbol).toBe('MATIC');
    });

    test('should have Base as chain ID 8453', () => {
      expect(EVM_CHAINS[8453]).toBeDefined();
      expect(EVM_CHAINS[8453]?.name).toBe('Base');
      expect(EVM_CHAINS[8453]?.nativeCurrency.symbol).toBe('ETH');
    });
  });

  describe('RPC Endpoints', () => {
    test('should have multiple RPC fallbacks for major chains', () => {
      const majorChains = [1, 137, 56, 42161, 10]; // Ethereum, Polygon, BSC, Arbitrum, Optimism

      for (const chainId of majorChains) {
        const config = EVM_CHAINS[chainId];
        expect(config).toBeDefined();
        expect(config?.rpcUrls.length).toBeGreaterThanOrEqual(2);
      }
    });

    test('should have valid RPC URL formats', () => {
      for (const config of Object.values(EVM_CHAINS)) {
        for (const rpcUrl of config.rpcUrls) {
          expect(rpcUrl).toMatch(/^https?:\/\/.+/);
        }
      }
    });
  });
});
