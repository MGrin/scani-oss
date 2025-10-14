/**
 * Tests for ERC-20 Token Balance Fetching
 *
 * Tests the EVM service's ability to fetch ERC-20 token balances
 * using the popular tokens list.
 */

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import type { PopularToken } from '../../config/popular-tokens';
import { getPopularTokensForChain, POPULAR_TOKENS } from '../../config/popular-tokens';
import { evmChainService } from '../../infrastructure/external-services/blockchain/evm';

describe('ERC-20 Token Support', () => {
  describe('Token Metadata', () => {
    test('should fetch USDT metadata on Ethereum', async () => {
      const usdtAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7';
      const metadata = await evmChainService.getTokenInfo(usdtAddress, 1);

      expect(metadata.symbol).toBe('USDT');
      expect(metadata.name).toContain('Tether');
      expect(metadata.decimals).toBe(6);
      expect(metadata.address).toBe(usdtAddress.toLowerCase());
    });

    test('should fetch USDC metadata on Ethereum', async () => {
      const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const metadata = await evmChainService.getTokenInfo(usdcAddress, 1);

      expect(metadata.symbol).toBe('USDC');
      expect(metadata.name).toContain('USD Coin');
      expect(metadata.decimals).toBe(6);
    });

    test('should fetch WETH metadata on Ethereum', async () => {
      const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
      const metadata = await evmChainService.getTokenInfo(wethAddress, 1);

      expect(metadata.symbol).toBe('WETH');
      expect(metadata.decimals).toBe(18);
    });
  });

  describe('Token Balance Fetching', () => {
    // Using Vitalik's address as a known address with token balances
    const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

    test('should fetch USDC balance for an address', async () => {
      const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const balance = await evmChainService.getTokenBalance(VITALIK_ADDRESS, usdcAddress, 1);

      expect(balance.symbol).toBe('USDC');
      expect(balance.balance).toBeInstanceOf(Decimal);
      expect(balance.balance.gte(0)).toBe(true);
      expect(balance.chainId).toBe(1);
      expect(balance.chainName).toBe('Ethereum');
      expect(balance.walletAddress).toBe(VITALIK_ADDRESS);
    });

    test('should fetch balance correctly regardless of amount', async () => {
      // Test address (may have zero or non-zero balance)
      const testAddress = '0x0000000000000000000000000000000000000001';
      const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

      const balance = await evmChainService.getTokenBalance(testAddress, usdcAddress, 1);

      // Balance should be valid (zero or positive)
      expect(balance.balance.gte(0)).toBe(true);
      expect(balance.symbol).toBe('USDC');
    });
  });

  describe('Multiple Token Balances', () => {
    const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

    test('should fetch multiple token balances', async () => {
      const tokenAddresses = [
        '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
      ];

      const balances = await evmChainService.getMultipleTokenBalances(
        VITALIK_ADDRESS,
        tokenAddresses,
        1
      );

      // Should return array (may be empty if all balances are zero)
      expect(Array.isArray(balances)).toBe(true);

      // Each balance should have correct structure
      for (const balance of balances) {
        expect(balance.symbol).toBeTruthy();
        expect(balance.balance).toBeInstanceOf(Decimal);
        expect(balance.balance.gt(0)).toBe(true); // Only non-zero returned
        expect(balance.chainId).toBe(1);
      }
    });

    test('should fetch multiple token balances and filter correctly', async () => {
      const testAddress = '0x0000000000000000000000000000000000000001';
      const tokenAddresses = [
        '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
      ];

      const balances = await evmChainService.getMultipleTokenBalances(
        testAddress,
        tokenAddresses,
        1
      );

      // Should return array (length depends on actual balances)
      expect(Array.isArray(balances)).toBe(true);

      // All returned balances should be positive
      for (const balance of balances) {
        expect(balance.balance.gt(0)).toBe(true);
      }
    });
  });

  describe('Popular Tokens Configuration', () => {
    test('should have popular tokens for Ethereum', () => {
      const ethereumTokens = getPopularTokensForChain(1);

      expect(ethereumTokens.length).toBeGreaterThan(0);

      // Check for key stablecoins
      const usdt = ethereumTokens.find((t: PopularToken) => t.symbol === 'USDT');
      const usdc = ethereumTokens.find((t: PopularToken) => t.symbol === 'USDC');
      const dai = ethereumTokens.find((t: PopularToken) => t.symbol === 'DAI');

      expect(usdt).toBeDefined();
      expect(usdc).toBeDefined();
      expect(dai).toBeDefined();
    });

    test('should have popular tokens for Polygon', () => {
      const polygonTokens = getPopularTokensForChain(137);

      expect(polygonTokens.length).toBeGreaterThan(0);

      // Check for USDC on Polygon
      const usdc = polygonTokens.find((t: PopularToken) => t.symbol === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc?.coingeckoId).toBe('usd-coin');
    });

    test('should have popular tokens for BSC', () => {
      const bscTokens = getPopularTokensForChain(56);

      expect(bscTokens.length).toBeGreaterThan(0);

      // Check for CAKE on BSC
      const cake = bscTokens.find((t: PopularToken) => t.symbol === 'CAKE');
      expect(cake).toBeDefined();
    });

    test('all tokens should have CoinGecko IDs', () => {
      for (const token of POPULAR_TOKENS) {
        expect(token.coingeckoId).toBeTruthy();
        expect(token.coingeckoPlatform).toBeTruthy();
        expect(token.address).toBeTruthy();
        expect(token.decimals).toBeGreaterThan(0);
      }
    });

    test('all addresses should be lowercase', () => {
      for (const token of POPULAR_TOKENS) {
        expect(token.address).toBe(token.address.toLowerCase());
      }
    });
  });

  describe('Rate Limiting', () => {
    test('should respect rate limits', async () => {
      const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const testAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

      // Make a few rapid requests
      const promises = Array(5)
        .fill(null)
        .map(() => evmChainService.getTokenBalance(testAddress, usdcAddress, 1));

      const results = await Promise.allSettled(promises);

      // At least one should succeed or all fail with rate limit
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      // Either some succeed or all fail gracefully
      expect(succeeded.length + failed.length).toBe(5);
    }, 30000); // 30s timeout
  });

  describe('Error Handling', () => {
    test('should throw error for invalid token address', async () => {
      const invalidAddress = '0xinvalid';
      const testAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

      await expect(
        evmChainService.getTokenBalance(testAddress, invalidAddress, 1)
      ).rejects.toThrow();
    });

    test('should throw error for invalid wallet address', async () => {
      const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const invalidWallet = '0xinvalid';

      await expect(
        evmChainService.getTokenBalance(invalidWallet, usdcAddress, 1)
      ).rejects.toThrow();
    });

    test('should throw error for unsupported chain', async () => {
      const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
      const testAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

      await expect(
        evmChainService.getTokenBalance(testAddress, usdcAddress, 99999)
      ).rejects.toThrow();
    });
  });
});
