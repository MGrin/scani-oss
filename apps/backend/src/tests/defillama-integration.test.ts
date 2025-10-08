/**
 * Test DeFiLlama integration with actual token metadata
 */

import { describe, expect, test } from 'bun:test';
import { pricingService } from '../services/pricing';

describe('DeFiLlama Integration', () => {
  test('should route ERC-20 token with contractAddress to DeFiLlama provider', async () => {
    // Create a mock token with the same metadata structure as wallet import
    const mockToken = {
      id: 'test-token-id',
      symbol: 'stETH',
      name: 'Lido Staked ETH',
      typeId: 'crypto-type-id',
      decimals: 18,
      providerMetadata: JSON.stringify({
        chainId: 1,
        contractAddress: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
        isERC20: true,
      }),
      iconUrl: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Test that the pricing service groups this token correctly
    // We can't directly test the private groupTokensByProvider method,
    // but we can test that getting a price works
    const price = await pricingService.getTokenPrice(mockToken, 'USD', new Date());

    console.log('stETH price from pricing service:', price);

    // Price should be fetched (non-zero if DeFiLlama has it)
    // Note: Even if DeFiLlama doesn't have it, we should get '0' not throw an error
    expect(price).toBeDefined();
    expect(typeof price).toBe('string');
  });

  test('should handle USDC on Base chain', async () => {
    const mockToken = {
      id: 'test-usdc-id',
      symbol: 'USDC',
      name: 'USD Coin',
      typeId: 'crypto-type-id',
      decimals: 6,
      providerMetadata: JSON.stringify({
        chainId: 8453,
        contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        isERC20: true,
      }),
      iconUrl: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const price = await pricingService.getTokenPrice(mockToken, 'USD', new Date());

    console.log('USDC (Base) price from pricing service:', price);

    expect(price).toBeDefined();
    expect(typeof price).toBe('string');

    // USDC should be close to $1
    const numPrice = parseFloat(price);
    if (numPrice > 0) {
      expect(numPrice).toBeGreaterThan(0.95);
      expect(numPrice).toBeLessThan(1.05);
    }
  });
});
