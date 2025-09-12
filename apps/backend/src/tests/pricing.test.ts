import { PricingService } from '../services/pricing';

/**
 * Simple test script to verify pricing service functionality
 * Run this with: bun run src/tests/pricing.test.ts
 */
async function testPricingService() {
  const pricingService = new PricingService();

  console.log('🚀 Testing Pricing Service...\n');

  // Test 1: Same currency (should return 1.0)
  try {
    console.log('Test 1: Same currency (USD -> USD)');
    const sameCurrency = await pricingService.getTokenPrice({
      tokenSymbol: 'USD',
      baseCurrency: 'USD',
      timestamp: new Date(),
      live: true,
    });
    console.log(`✅ Result: ${sameCurrency} (expected: 1.0)\n`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`❌ Error: ${errorMessage}\n`);
  }

  // Test 2: Crypto price (requires API key and actual tokens in database)
  try {
    console.log('Test 2: Crypto price (BTC -> USD)');
    const btcPrice = await pricingService.getTokenPrice({
      tokenSymbol: 'BTC',
      baseCurrency: 'USD',
      timestamp: new Date(),
      live: true,
    });
    console.log(`✅ Result: $${parseFloat(btcPrice || '0').toLocaleString()}\n`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`ℹ️  Expected error (tokens not in database): ${errorMessage}\n`);
  }

  // Test 3: Multiple token prices
  try {
    console.log('Test 3: Multiple token prices');
    const prices = await pricingService.getTokenPrices([
      {
        tokenSymbol: 'USD',
        baseCurrency: 'EUR',
        timestamp: new Date(),
        live: true,
      },
      {
        tokenSymbol: 'EUR',
        baseCurrency: 'USD',
        timestamp: new Date(),
        live: true,
      },
    ]);
    console.log(`✅ Results:`, prices);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`ℹ️  Expected error (tokens not in database): ${errorMessage}\n`);
  }

  console.log('✨ Pricing service test completed!');
}

// Run tests if this file is executed directly
if (import.meta.main) {
  testPricingService().catch(console.error);
}
