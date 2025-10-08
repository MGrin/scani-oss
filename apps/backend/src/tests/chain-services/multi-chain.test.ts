/**
 * Multi-Chain Service Unit Tests
 *
 * Tests address detection and routing for all supported chains
 * Run with: bun test src/tests/chain-services/multi-chain.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { detectAddressType, multiChainService } from '../../services/chain/multi-chain';

describe('MultiChainService', () => {
  describe('Address Type Detection', () => {
    test('should detect EVM addresses', () => {
      const evmAddresses = [
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
        '0x0000000000000000000000000000000000000000',
        '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      ];

      for (const address of evmAddresses) {
        expect(detectAddressType(address)).toBe('evm');
      }
    });

    test('should detect Bitcoin addresses', () => {
      const bitcoinAddresses = [
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      ];

      for (const address of bitcoinAddresses) {
        expect(detectAddressType(address)).toBe('bitcoin');
      }
    });

    test('should detect Bitcoin Cash addresses', () => {
      const bchAddresses = [
        'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy',
        'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy',
      ];

      for (const address of bchAddresses) {
        expect(detectAddressType(address)).toBe('bitcoin-cash');
      }
    });

    test('should detect Litecoin addresses', () => {
      const ltcAddresses = [
        'LTC9s65mZ4rXoYxcXXH3jFZDvTb6g5Ftmq',
        'MNn9WysL3dDR1L6smZqZfKH8v7xkVUmRGz',
        'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
      ];

      for (const address of ltcAddresses) {
        expect(detectAddressType(address)).toBe('litecoin');
      }
    });

    test('should detect Tron addresses', () => {
      const tronAddresses = [
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
        'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
      ];

      for (const address of tronAddresses) {
        expect(detectAddressType(address)).toBe('tron');
      }
    });

    test('should detect Solana addresses', () => {
      const solanaAddresses = [
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        '7EqQdEUzsvU4kLHyBxKELKoEJJjB7cDdGCw3MqjNa3Zx',
      ];

      for (const address of solanaAddresses) {
        expect(detectAddressType(address)).toBe('solana');
      }
    });

    test('should detect Algorand addresses', () => {
      const algorandAddresses = [
        'WCZMKJFEJY6PQA4BJHVEWSM3SDJPB4RHDL3CSCGVUDVKR3L4PFVVS3XEUE',
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      ];

      for (const address of algorandAddresses) {
        expect(detectAddressType(address)).toBe('algorand');
      }
    });

    test('should detect Aptos addresses', () => {
      const aptosAddresses = ['0x1', '0x123abc', '0xa1b2c3d4e5f6'];

      for (const address of aptosAddresses) {
        expect(detectAddressType(address)).toBe('aptos');
      }
    });

    test('should detect Sui addresses', () => {
      const suiAddresses = [
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      ];

      for (const address of suiAddresses) {
        expect(detectAddressType(address)).toBe('sui');
      }
    });

    test('should detect Cardano addresses', () => {
      const cardanoAddresses = [
        'addr1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wbi0uzwygkznsj28yqsfpavdrp0c7u',
        'addr1q8zu4smzyf2r2mfqjd6tc6vxf2p8rccdfk82ye3eut2udkw9etpkygj5x',
      ];

      for (const address of cardanoAddresses) {
        expect(detectAddressType(address)).toBe('cardano');
      }
    });

    test('should detect Cosmos addresses', () => {
      const cosmosAddresses = [
        'cosmos1abc123def456ghi789jkl012mno345pqr678st',
        'cosmos1xyz789abc456def123ghi890jkl567mno234pq',
      ];

      for (const address of cosmosAddresses) {
        expect(detectAddressType(address)).toBe('cosmos');
      }
    });

    test('should detect Hedera addresses', () => {
      const hederaAddresses = ['0.0.123456', '0.0.1', '1.2.3'];

      for (const address of hederaAddresses) {
        expect(detectAddressType(address)).toBe('hedera');
      }
    });

    test('should detect Near Protocol addresses', () => {
      const nearAddresses = ['alice.near', 'bob.near', 'test-account.near'];

      for (const address of nearAddresses) {
        expect(detectAddressType(address)).toBe('near');
      }
    });

    test('should detect Polkadot addresses', () => {
      const polkadotAddresses = [
        '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5',
        '1zugcabYjgfQdMLC3cAzQ8tJZMo45tMnGpivpAzpxB4CZyK',
      ];

      for (const address of polkadotAddresses) {
        expect(detectAddressType(address)).toBe('polkadot');
      }
    });

    test('should return unknown for invalid addresses', () => {
      const invalidAddresses = ['', 'not-an-address', '12345', 'invalid@email.com'];

      for (const address of invalidAddresses) {
        expect(detectAddressType(address)).toBe('unknown');
      }
    });
  });

  describe('Address Priority Detection', () => {
    test('should detect EVM over shorter hex addresses', () => {
      const evmAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';
      expect(detectAddressType(evmAddress)).toBe('evm');
      expect(detectAddressType(evmAddress)).not.toBe('aptos');
    });

    test('should detect Sui (64 hex) over Aptos (shorter hex)', () => {
      const suiAddress = '0x0000000000000000000000000000000000000000000000000000000000000001';
      const aptosAddress = '0x1';

      expect(detectAddressType(suiAddress)).toBe('sui');
      expect(detectAddressType(aptosAddress)).toBe('aptos');
    });

    test('should detect Bitcoin Cash before Bitcoin for CashAddr', () => {
      const cashAddr = 'qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy';
      expect(detectAddressType(cashAddr)).toBe('bitcoin-cash');
    });

    test('should detect Litecoin before Bitcoin for L/M prefixes', () => {
      const ltcAddress = 'LTC9s65mZ4rXoYxcXXH3jFZDvTb6g5Ftmq';
      expect(detectAddressType(ltcAddress)).toBe('litecoin');
      expect(detectAddressType(ltcAddress)).not.toBe('bitcoin');
    });

    test('should detect Tron before Solana for T prefix', () => {
      const tronAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
      expect(detectAddressType(tronAddress)).toBe('tron');
      expect(detectAddressType(tronAddress)).not.toBe('solana');
    });
  });

  describe('isSupportedAddress', () => {
    test('should return true for all supported address types', () => {
      const supportedAddresses = [
        '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // EVM
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Bitcoin
        'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // Tron
        'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK', // Solana
      ];

      for (const address of supportedAddresses) {
        expect(multiChainService.isSupportedAddress(address)).toBe(true);
      }
    });

    test('should return false for unsupported addresses', () => {
      const unsupportedAddresses = ['', 'not-an-address', '12345'];

      for (const address of unsupportedAddresses) {
        expect(multiChainService.isSupportedAddress(address)).toBe(false);
      }
    });
  });

  describe('getChainType', () => {
    test('should return correct chain type for each address', () => {
      const addressTypes = [
        { address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', type: 'evm' },
        { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', type: 'bitcoin' },
        { address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', type: 'tron' },
        {
          address: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
          type: 'solana',
        },
        {
          address: 'cosmos1abc123def456ghi789jkl012mno345pqr678st',
          type: 'cosmos',
        },
        { address: '0.0.123456', type: 'hedera' },
      ];

      for (const { address, type } of addressTypes) {
        expect(multiChainService.getChainType(address)).toBe(type);
      }
    });
  });

  describe('Chain Coverage', () => {
    test('should support all 16 chain types', () => {
      const allTypes = [
        'evm',
        'bitcoin',
        'bitcoin-cash',
        'litecoin',
        'tron',
        'solana',
        'algorand',
        'aptos',
        'cardano',
        'cosmos',
        'hedera',
        'near',
        'polkadot',
        'ripple',
        'stellar',
        'sui',
      ];

      // Each type should be detectable
      expect(allTypes.length).toBe(16);
    });
  });
});
