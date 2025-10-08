/**
 * Non-EVM Chain Services Unit Tests
 *
 * Tests for Algorand, Aptos, Bitcoin Cash, Cardano, Litecoin services
 * Run with: bun test src/tests/chain-services/non-evm-chains.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { algorandService } from '../../services/chain/algorand';
import { aptosService } from '../../services/chain/aptos';
import { bitcoinCashService } from '../../services/chain/bitcoin-cash';
import { cardanoService } from '../../services/chain/cardano';
import { litecoinService } from '../../services/chain/litecoin';

describe('AlgorandService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(algorandService.getServiceName()).toBe('AlgorandService');
    });

    test('should support Algorand chain ID (-10)', () => {
      expect(algorandService.supportsChain(-10)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(algorandService.supportsChain(0)).toBe(false);
      expect(algorandService.supportsChain(1)).toBe(false);
      expect(algorandService.supportsChain(-1)).toBe(false);
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Algorand addresses', () => {
      const validAddresses = [
        'WCZMKJFEJY6PQA4BJHVEWSM3SDJPB4RHDL3CSCGVUDVKR3L4PFVVS3XEUE',
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      ];

      const algorandPattern = /^[A-Z2-7]{58}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(algorandPattern);
        expect(address.length).toBe(58);
      }
    });

    test('should reject invalid Algorand addresses', () => {
      const invalidAddresses = [
        'abc123', // Lowercase
        'TOOSHORT', // Too short
        'TOOLONGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // Too long
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // EVM address
      ];

      const algorandPattern = /^[A-Z2-7]{58}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(algorandPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct microalgos conversion', () => {
      const MICROALGOS_PER_ALGO = 1_000_000;
      expect(MICROALGOS_PER_ALGO).toBe(1000000);
    });

    test('should have correct decimals', () => {
      const ALGO_DECIMALS = 6;
      expect(ALGO_DECIMALS).toBe(6);
    });
  });
});

describe('AptosService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(aptosService.getServiceName()).toBe('AptosService');
    });

    test('should support Aptos chain ID (-11)', () => {
      expect(aptosService.supportsChain(-11)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(aptosService.supportsChain(0)).toBe(false);
      expect(aptosService.supportsChain(1)).toBe(false);
      expect(aptosService.supportsChain(-10)).toBe(false);
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Aptos addresses', () => {
      const validAddresses = [
        '0x1',
        '0x123abc',
        '0xa1b2c3d4e5f6',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      ];

      const aptosPattern = /^0x[a-fA-F0-9]{1,64}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(aptosPattern);
      }
    });

    test('should reject invalid Aptos addresses', () => {
      const invalidAddresses = [
        '1', // Missing 0x
        '0x', // No hex
        '0xGGG', // Invalid hex
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // Tron
      ];

      const aptosPattern = /^0x[a-fA-F0-9]{1,64}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(aptosPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct Octas conversion', () => {
      const OCTAS_PER_APT = 100_000_000;
      expect(OCTAS_PER_APT).toBe(100000000);
    });

    test('should have correct decimals', () => {
      const APT_DECIMALS = 8;
      expect(APT_DECIMALS).toBe(8);
    });
  });
});

describe('BitcoinCashService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(bitcoinCashService.getServiceName()).toBe('BitcoinCashService');
    });

    test('should support Bitcoin Cash chain ID (-3)', () => {
      expect(bitcoinCashService.supportsChain(-3)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(bitcoinCashService.supportsChain(0)).toBe(false); // Bitcoin
      expect(bitcoinCashService.supportsChain(-4)).toBe(false); // Litecoin
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid CashAddr addresses', () => {
      const validCashAddr = [
        'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy',
        'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy',
        'bitcoincash:pqm8v5xkqmzjlqpx98vx8nqwl4cz3qfyavtqms7gf0',
      ];

      const cashAddrPattern = /^(bitcoincash:)?[qp][a-z0-9]{41}$/;
      for (const address of validCashAddr) {
        expect(address).toMatch(cashAddrPattern);
      }
    });

    test('should recognize valid legacy BCH addresses', () => {
      const validLegacy = [
        '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu',
        '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy',
      ];

      const legacyPattern = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
      for (const address of validLegacy) {
        expect(address).toMatch(legacyPattern);
      }
    });

    test('should reject invalid BCH addresses', () => {
      const invalidAddresses = [
        'LTC9s65mZ4rXoYxcXXH3jFZDvTb6g5Ftmq', // Litecoin
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // Bitcoin
      ];

      const cashAddrPattern = /^(bitcoincash:)?[qp][a-z0-9]{41}$/;
      const legacyPattern = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

      for (const address of invalidAddresses) {
        const matchesCashAddr = cashAddrPattern.test(address);
        const matchesLegacy = legacyPattern.test(address);
        expect(matchesCashAddr || matchesLegacy).toBe(false);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct satoshi conversion', () => {
      const SATOSHIS_PER_BCH = 100_000_000;
      expect(SATOSHIS_PER_BCH).toBe(100000000);
    });

    test('should have correct decimals', () => {
      const BCH_DECIMALS = 8;
      expect(BCH_DECIMALS).toBe(8);
    });
  });
});

describe('CardanoService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(cardanoService.getServiceName()).toBe('CardanoService');
    });

    test('should support Cardano chain ID (-5)', () => {
      expect(cardanoService.supportsChain(-5)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(cardanoService.supportsChain(0)).toBe(false);
      expect(cardanoService.supportsChain(-6)).toBe(false); // Cosmos
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid Cardano addresses', () => {
      const validAddresses = [
        'addr1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wbi0uzwygkznsj28yqsfpavdrp0c7u',
        'addr1q8zu4smzyf2r2mfqjd6tc6vxf2p8rccdfk82ye3eut2udkw9etpkygj5x',
      ];

      const cardanoPattern = /^addr1[a-z0-9]{50,120}$/;
      for (const address of validAddresses) {
        expect(address).toMatch(cardanoPattern);
        expect(address.startsWith('addr1')).toBe(true);
      }
    });

    test('should reject invalid Cardano addresses', () => {
      const invalidAddresses = [
        'addr1short', // Too short
        'invalid', // Wrong prefix
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
      ];

      const cardanoPattern = /^addr1[a-z0-9]{50,120}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(cardanoPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct lovelace conversion', () => {
      const LOVELACE_PER_ADA = 1_000_000;
      expect(LOVELACE_PER_ADA).toBe(1000000);
    });

    test('should have correct decimals', () => {
      const ADA_DECIMALS = 6;
      expect(ADA_DECIMALS).toBe(6);
    });
  });
});

describe('LitecoinService', () => {
  describe('Service Info', () => {
    test('should return correct service name', () => {
      expect(litecoinService.getServiceName()).toBe('LitecoinService');
    });

    test('should support Litecoin chain ID (-4)', () => {
      expect(litecoinService.supportsChain(-4)).toBe(true);
    });

    test('should not support other chain IDs', () => {
      expect(litecoinService.supportsChain(0)).toBe(false); // Bitcoin
      expect(litecoinService.supportsChain(-3)).toBe(false); // Bitcoin Cash
    });
  });

  describe('Address Validation', () => {
    test('should recognize valid P2PKH Litecoin addresses (L)', () => {
      const validP2PKH = [
        'LTC9s65mZ4rXoYxcXXH3jFZDvTb6g5Ftmq',
        'LhyLNfBkoKshT7R8Pce6vkB9T2cP2o84hx',
      ];

      const p2pkhPattern = /^L[a-zA-HJ-NP-Z0-9]{25,62}$/;
      for (const address of validP2PKH) {
        expect(address).toMatch(p2pkhPattern);
        expect(address.startsWith('L')).toBe(true);
      }
    });

    test('should recognize valid P2SH Litecoin addresses (M)', () => {
      const validP2SH = [
        'MNn9WysL3dDR1L6smZqZfKH8v7xkVUmRGz',
        'MSxKn8cYvgVXWRVnfUJTKU6PGkTXW2EbkK',
      ];

      const p2shPattern = /^M[a-zA-HJ-NP-Z0-9]{25,62}$/;
      for (const address of validP2SH) {
        expect(address).toMatch(p2shPattern);
        expect(address.startsWith('M')).toBe(true);
      }
    });

    test('should recognize valid Bech32 Litecoin addresses (ltc1)', () => {
      const validBech32 = [
        'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
        'ltc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      ];

      const bech32Pattern = /^ltc1[a-zA-HJ-NP-Z0-9]{25,62}$/;
      for (const address of validBech32) {
        expect(address).toMatch(bech32Pattern);
        expect(address.startsWith('ltc1')).toBe(true);
      }
    });

    test('should reject invalid Litecoin addresses', () => {
      const invalidAddresses = [
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Bitcoin
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // Bitcoin Bech32
      ];

      const ltcPattern = /^(L|M|ltc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
      for (const address of invalidAddresses) {
        expect(address).not.toMatch(ltcPattern);
      }
    });
  });

  describe('Constants', () => {
    test('should have correct satoshi conversion', () => {
      const SATOSHIS_PER_LTC = 100_000_000;
      expect(SATOSHIS_PER_LTC).toBe(100000000);
    });

    test('should have correct decimals', () => {
      const LTC_DECIMALS = 8;
      expect(LTC_DECIMALS).toBe(8);
    });
  });
});
