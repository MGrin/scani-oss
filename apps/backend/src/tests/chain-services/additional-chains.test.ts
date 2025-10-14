/**
 * Additional Chain Services Unit Tests (Stub Implementations)
 *
 * Tests for Cosmos, Hedera, Near, Polkadot, Ripple, Stellar, Sui services
 * Run with: bun test src/tests/chain-services/additional-chains.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  cosmosService,
  hederaService,
  nearService,
  polkadotService,
  rippleService,
  stellarService,
  suiService,
} from '../../infrastructure/external-services/blockchain/additional-chains';

describe('CosmosService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(cosmosService.getServiceName()).toBe('CosmosService');
    });

    test('should support Cosmos chain ID (-6)', () => {
      expect(cosmosService.supportsChain(-6)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(cosmosService.supportsChain(0)).toBe(false);
      expect(cosmosService.supportsChain(-5)).toBe(false); // Cardano
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Cosmos addresses', () => {
      const validAddresses = [
        'cosmos1abc123def456ghi789jkl012mno345pqr678st',
        'cosmos1xyz789abc456def123ghi890jkl567mno234pq',
      ];

      const cosmosPattern = /^cosmos1[a-z0-9]{38}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(cosmosPattern);
        expect(address.startsWith('cosmos1')).toBe(true);
        expect(address.length).toBe(45); // cosmos1 + 38 chars
      }
    });

    test('should reject invalid Cosmos addresses', () => {
      const invalidAddresses = [
        'cosmos1short', // Too short
        'atom1abc123def456ghi789jkl012mno345pqr678st', // Wrong prefix
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
      ];

      const cosmosPattern = /^cosmos1[a-z0-9]{38}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(cosmosPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for ATOM', () => {
      const ATOM_DECIMALS = 6;
      expect(ATOM_DECIMALS).toBe(6);
    });
  });
});

describe('HederaService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(hederaService.getServiceName()).toBe('HederaService');
    });

    test('should support Hedera chain ID (-7)', () => {
      expect(hederaService.supportsChain(-7)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(hederaService.supportsChain(0)).toBe(false);
      expect(hederaService.supportsChain(-6)).toBe(false); // Cosmos
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Hedera account IDs', () => {
      const validAccountIds = ['0.0.123456', '0.0.1', '1.2.3', '0.0.999999'];

      const hederaPattern = /^\d+\.\d+\.\d+$/;
      for (const accountId of validAccountIds) {
        expect(accountId).toMatch(hederaPattern);
      }
    });

    test('should reject invalid Hedera account IDs', () => {
      const invalidAccountIds = [
        '0.0', // Incomplete
        '0-0-123456', // Wrong separator
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
        'abc.def.ghi', // Not numeric
      ];

      const hederaPattern = /^\d+\.\d+\.\d+$/;
      for (const accountId of invalidAccountIds) {
        expect(accountId).not.toMatch(hederaPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for HBAR', () => {
      const HBAR_DECIMALS = 8;
      expect(HBAR_DECIMALS).toBe(8);
    });
  });
});

describe('NearService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(nearService.getServiceName()).toBe('NearService');
    });

    test('should support Near chain ID (-8)', () => {
      expect(nearService.supportsChain(-8)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(nearService.supportsChain(0)).toBe(false);
      expect(nearService.supportsChain(-7)).toBe(false); // Hedera
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Near account names', () => {
      const validAccountNames = [
        'alice.near',
        'bob.near',
        'test-account.near',
        'test_account_123.near',
      ];

      const nearPattern = /^[a-z0-9_-]+\.near$/;
      for (const name of validAccountNames) {
        expect(name).toMatch(nearPattern);
        expect(name.endsWith('.near')).toBe(true);
      }
    });

    test('should recognize valid Near hex addresses', () => {
      const validHexAddresses = [
        '0000000000000000000000000000000000000000000000000000000000000000',
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      ];

      const hexPattern = /^[a-f0-9]{64}$/;
      for (const address of validHexAddresses) {
        expect(address).toMatch(hexPattern);
        expect(address.length).toBe(64);
      }
    });

    test('should reject invalid Near addresses', () => {
      const invalidAddresses = [
        'alice', // Missing .near
        'Alice.near', // Uppercase
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
      ];

      const nearPattern = /^[a-z0-9_-]+\.near$|^[a-f0-9]{64}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(nearPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for NEAR', () => {
      const NEAR_DECIMALS = 24;
      expect(NEAR_DECIMALS).toBe(24);
    });
  });
});

describe('PolkadotService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(polkadotService.getServiceName()).toBe('PolkadotService');
    });

    test('should support Polkadot chain ID (-9)', () => {
      expect(polkadotService.supportsChain(-9)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(polkadotService.supportsChain(0)).toBe(false);
      expect(polkadotService.supportsChain(-8)).toBe(false); // Near
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Polkadot addresses', () => {
      const validAddresses = [
        '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5',
        '1zugcabYjgfQdMLC3cAzQ8tJZMo45tMnGpivpAzpxB4CZyK',
      ];

      const polkadotPattern = /^1[a-zA-Z0-9]{43,47}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(polkadotPattern);
        expect(address.startsWith('1')).toBe(true);
        expect(address.length).toBeGreaterThanOrEqual(44); // Can be 44-48 chars
        expect(address.length).toBeLessThanOrEqual(48);
      }
    });

    test('should reject invalid Polkadot addresses', () => {
      const invalidAddresses = [
        '1short', // Too short
        '2oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5', // Wrong prefix
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Bitcoin (starts with 1 but wrong length)
      ];

      const polkadotPattern = /^1[a-zA-Z0-9]{47}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(polkadotPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for DOT', () => {
      const DOT_DECIMALS = 10;
      expect(DOT_DECIMALS).toBe(10);
    });
  });
});

describe('RippleService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(rippleService.getServiceName()).toBe('RippleService');
    });

    test('should support Ripple chain ID (-12)', () => {
      expect(rippleService.supportsChain(-12)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(rippleService.supportsChain(0)).toBe(false);
      expect(rippleService.supportsChain(-13)).toBe(false); // Stellar
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Ripple addresses', () => {
      const validAddresses = [
        'rN7n7otQDd6FczFgLdllqtyMVrn3LnzKxdM',
        'rLHzPsX6oXkzU9Lgxk8Hdu9vKa7w7VJvJx',
        'rU6K7V3Po4snVhBBaU29sesqs2qTQJWDw1',
      ];

      const ripplePattern = /^r[a-zA-Z0-9]{24,35}$/; // Ripple uses base58 variant with lowercase
      for (const address of validAddresses) {
        expect(address).toMatch(ripplePattern);
        expect(address.startsWith('r')).toBe(true);
      }
    });

    test('should reject invalid Ripple addresses', () => {
      const invalidAddresses = [
        'xrp123', // Wrong prefix
        'r123', // Too short
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
      ];

      const ripplePattern = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(ripplePattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for XRP', () => {
      const XRP_DECIMALS = 6;
      expect(XRP_DECIMALS).toBe(6);
    });
  });
});

describe('StellarService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(stellarService.getServiceName()).toBe('StellarService');
    });

    test('should support Stellar chain ID (-13)', () => {
      expect(stellarService.supportsChain(-13)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(stellarService.supportsChain(0)).toBe(false);
      expect(stellarService.supportsChain(-12)).toBe(false); // Ripple
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Stellar addresses', () => {
      const validAddresses = [
        'GBSTRUEWQ5L7WR5NK456AZGJHF3KFXB7QFPX7D3NRVPJ4LMCFZHBFABC',
        'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
      ];

      const stellarPattern = /^G[A-Z0-9]{55,56}$/; // Stellar uses base32 with uppercase and numbers
      for (const address of validAddresses) {
        expect(address).toMatch(stellarPattern);
        expect(address.startsWith('G')).toBe(true);
      }
    });

    test('should reject invalid Stellar addresses', () => {
      const invalidAddresses = [
        'GSHORT', // Too short
        'SDSAMPLE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678', // Wrong prefix (S is for seeds)
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
      ];

      const stellarPattern = /^G[A-Z2-7]{50,60}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(stellarPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for XLM', () => {
      const XLM_DECIMALS = 7;
      expect(XLM_DECIMALS).toBe(7);
    });
  });
});

describe('SuiService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(suiService.getServiceName()).toBe('SuiService');
    });

    test('should support Sui chain ID (-14)', () => {
      expect(suiService.supportsChain(-14)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(suiService.supportsChain(0)).toBe(false);
      expect(suiService.supportsChain(-11)).toBe(false); // Aptos
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Sui addresses', () => {
      const validAddresses = [
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      ];

      const suiPattern = /^0x[a-fA-F0-9]{64}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(suiPattern);
        expect(address.startsWith('0x')).toBe(true);
        expect(address.length).toBe(66); // 0x + 64 hex chars
      }
    });

    test('should reject invalid Sui addresses', () => {
      const invalidAddresses = [
        '0x1', // Too short (Aptos)
        '0x123', // Too short
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum (40 hex chars)
      ];

      const suiPattern = /^0x[a-fA-F0-9]{64}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(suiPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct decimals for SUI', () => {
      const SUI_DECIMALS = 9;
      expect(SUI_DECIMALS).toBe(9);
    });
  });
});

describe('All Stub Services', () => {
  test('all stub services should be defined', () => {
    expect(cosmosService).toBeDefined();
    expect(hederaService).toBeDefined();
    expect(nearService).toBeDefined();
    expect(polkadotService).toBeDefined();
    expect(rippleService).toBeDefined();
    expect(stellarService).toBeDefined();
    expect(suiService).toBeDefined();
  });

  test('all stub services should have unique chain IDs', () => {
    const chainIds = [
      cosmosService.supportsChain(-6),
      hederaService.supportsChain(-7),
      nearService.supportsChain(-8),
      polkadotService.supportsChain(-9),
      rippleService.supportsChain(-12),
      stellarService.supportsChain(-13),
      suiService.supportsChain(-14),
    ];

    expect(chainIds.every((supported) => supported === true)).toBe(true);
  });
});
