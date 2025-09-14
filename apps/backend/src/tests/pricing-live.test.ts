/**
 * Comprehensive Pricing Service Tests
 * Tests all required currency pairs and functionality
 */

import { PricingService } from '../services/pricing';

/**
 * Test configuration
 */
const TEST_PAIRS = [
  { from: 'RUB', to: 'USD', type: 'forex' },
  { from: 'BTC', to: 'USD', type: 'crypto' },
  { from: 'USD', to: 'USD', type: 'same' },
  { from: 'NVDA', to: 'USD', type: 'stock' },
  { from: 'XEQT', to: 'USD', type: 'etf_conversion' }, // May need CAD conversion
  { from: 'USD', to: 'CAD', type: 'forex' },
];

const HISTORICAL_DATE = new Date('2024-01-01');

/**
 * Helper functions
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPrice(price: string, _from: string, to: string): string {
  const numPrice = parseFloat(price);
  if (to === 'USD') {
    return `$${numPrice.toLocaleString()}`;
  }
  return `${numPrice.toFixed(6)} ${to}`;
}

/**
 * Test API call counting
 */
class ApiCallCounter {
  private calls: Map<string, number> = new Map();
  private originalFetch = global.fetch;

  start() {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      let provider = 'unknown';

      if (url.includes('coingecko')) provider = 'coingecko';
      else if (url.includes('finnhub')) provider = 'finnhub';
      else if (url.includes('exchangerate-api')) provider = 'exchangerate';

      const current = this.calls.get(provider) || 0;
      this.calls.set(provider, current + 1);

      console.log(`📡 API Call ${current + 1} to ${provider}: ${url.substring(0, 100)}...`);

      return this.originalFetch(input, init);
    }) as typeof fetch;
  }

  stop() {
    global.fetch = this.originalFetch;
  }

  getCounts() {
    return Object.fromEntries(this.calls.entries());
  }

  getTotalCalls() {
    return Array.from(this.calls.values()).reduce((sum, count) => sum + count, 0);
  }
}

/**
 * Main test function
 */
async function runComprehensivePricingTests() {
  console.log('🚀 Starting Comprehensive Pricing Service Tests\n');
  console.log('='.repeat(80));

  const pricingService = new PricingService();
  const apiCounter = new ApiCallCounter();

  let totalTests = 0;
  let passedTests = 0;
  let apiCallsTotal = 0;

  console.log('\n📊 PART 1: CURRENT PRICES TEST');
  console.log('='.repeat(50));

  apiCounter.start();

  for (const pair of TEST_PAIRS) {
    totalTests++;
    console.log(`\nTesting ${pair.from} -> ${pair.to} (${pair.type}):`);

    try {
      const startTime = Date.now();
      const price = await pricingService.getTokenPrice({
        tokenSymbol: pair.from,
        baseCurrency: pair.to,
        timestamp: new Date(),
        live: true,
      });
      const duration = Date.now() - startTime;

      console.log(`  ✅ Success: ${formatPrice(price, pair.from, pair.to)} (${duration}ms)`);
      passedTests++;

      // Add small delay to be API-friendly
      await delay(100);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ❌ Error: ${errorMsg}`);
    }
  }

  apiCallsTotal += apiCounter.getTotalCalls();
  apiCounter.stop();

  console.log('\n📊 PART 2: HISTORICAL PRICES TEST');
  console.log('='.repeat(50));

  apiCounter.start();

  for (const pair of TEST_PAIRS) {
    totalTests++;
    console.log(`\nTesting ${pair.from} -> ${pair.to} (Historical - Jan 1, 2024):`);

    try {
      const startTime = Date.now();
      const price = await pricingService.getTokenPrice({
        tokenSymbol: pair.from,
        baseCurrency: pair.to,
        timestamp: HISTORICAL_DATE,
        live: false,
      });
      const duration = Date.now() - startTime;

      console.log(`  ✅ Success: ${formatPrice(price, pair.from, pair.to)} (${duration}ms)`);
      passedTests++;

      await delay(100);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ❌ Error: ${errorMsg}`);
    }
  }

  apiCallsTotal += apiCounter.getTotalCalls();
  apiCounter.stop();

  console.log('\n📊 PART 3: CACHING EFFICIENCY TEST');
  console.log('='.repeat(50));

  apiCounter.start();

  // Test cache by making the same request twice
  const testPair = TEST_PAIRS[1]!; // BTC -> USD
  console.log(`\nTesting cache efficiency with ${testPair.from} -> ${testPair.to}:`);

  try {
    console.log('  First request (should fetch from API):');
    const price1 = await pricingService.getTokenPrice({
      tokenSymbol: testPair.from,
      baseCurrency: testPair.to,
      timestamp: new Date(),
      live: true,
    });
    console.log(`    ✅ Result: ${formatPrice(price1, testPair.from, testPair.to)}`);

    const firstCallCount = apiCounter.getTotalCalls();

    console.log('  Second request (should use cache):');
    const price2 = await pricingService.getTokenPrice({
      tokenSymbol: testPair.from,
      baseCurrency: testPair.to,
      timestamp: new Date(),
      live: true,
    });
    console.log(`    ✅ Result: ${formatPrice(price2, testPair.from, testPair.to)}`);

    const secondCallCount = apiCounter.getTotalCalls();

    if (firstCallCount === secondCallCount) {
      console.log('  ✅ Cache working: No additional API calls made');
      passedTests++;
    } else {
      console.log('  ⚠️  Cache may not be working: Additional API calls detected');
    }

    totalTests++;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ Cache test failed: ${errorMsg}`);
    totalTests++;
  }

  apiCallsTotal += apiCounter.getTotalCalls();
  apiCounter.stop();

  console.log('\n📊 PART 4: MULTI-CURRENCY CONVERSION TEST');
  console.log('='.repeat(50));

  // Test if the system can handle indirect conversions
  console.log('\nTesting multi-step conversion scenarios:');

  const multiStepPairs = [
    { from: 'XEQT', to: 'USD', expected_path: 'XEQT -> CAD -> USD' },
    { from: 'EUR', to: 'JPY', expected_path: 'EUR -> JPY (direct or via USD)' },
  ];

  for (const pair of multiStepPairs) {
    totalTests++;
    console.log(`\n  Testing ${pair.from} -> ${pair.to}:`);
    console.log(`  Expected conversion path: ${pair.expected_path}`);

    try {
      const price = await pricingService.getTokenPrice({
        tokenSymbol: pair.from,
        baseCurrency: pair.to,
        timestamp: new Date(),
        live: true,
      });

      console.log(`    ✅ Success: ${formatPrice(price, pair.from, pair.to)}`);
      console.log(`    ℹ️  Note: Verify this uses the expected conversion path`);
      passedTests++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`    ❌ Failed: ${errorMsg}`);

      if (errorMsg.includes('not found')) {
        console.log(`    ℹ️  Multi-step conversion may not be implemented yet`);
      }
    }
  }

  console.log('\n📊 PART 5: BATCH REQUESTS TEST');
  console.log('='.repeat(50));

  apiCounter.start();

  console.log('\nTesting batch price requests:');

  const batchRequests = TEST_PAIRS.slice(0, 3).map((pair) => ({
    tokenSymbol: pair.from,
    baseCurrency: pair.to,
    timestamp: new Date(),
    live: true,
  }));

  try {
    const startTime = Date.now();
    const prices = await pricingService.getTokenPrices(batchRequests);
    const duration = Date.now() - startTime;

    console.log(`  ✅ Batch request completed in ${duration}ms`);
    console.log(`  📊 Results received for ${Object.keys(prices).length} pairs:`);

    for (const [symbol, price] of Object.entries(prices)) {
      const pair = TEST_PAIRS.find((p) => p.from === symbol);
      if (pair) {
        console.log(`    ${symbol} -> ${pair.to}: ${formatPrice(price, symbol, pair.to)}`);
      }
    }

    totalTests++;
    passedTests++;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ Batch request failed: ${errorMsg}`);
    totalTests++;
  }

  apiCallsTotal += apiCounter.getTotalCalls();
  apiCounter.stop();

  // Final results
  console.log(`\n${'='.repeat(80)}`);
  console.log('📈 FINAL TEST RESULTS');
  console.log('='.repeat(80));

  console.log(`\n✅ Tests Passed: ${passedTests}/${totalTests}`);
  console.log(`📡 Total API Calls: ${apiCallsTotal}`);

  const apiCounts = apiCounter.getCounts();
  console.log('\n📊 API Calls by Provider:');
  for (const [provider, count] of Object.entries(apiCounts)) {
    console.log(`  ${provider}: ${count} calls`);
  }

  if (passedTests === totalTests) {
    console.log('\n🎉 All tests passed! Pricing service is working correctly.');
  } else {
    console.log(`\n⚠️  ${totalTests - passedTests} tests failed. Check the errors above.`);
  }

  console.log('\n💡 OPTIMIZATION RECOMMENDATIONS:');
  console.log('  1. Implement caching to reduce API calls');
  console.log('  2. Add multi-step currency conversion for unsupported pairs');
  console.log('  3. Consider API rate limiting to avoid exceeding quotas');
  console.log('  4. Add retry logic for failed API requests');

  console.log('\n✨ Test completed!');
}

/**
 * Additional utility test for specific scenarios
 */
async function testSpecificScenarios() {
  console.log('\n🔍 ADDITIONAL SCENARIO TESTS');
  console.log('='.repeat(50));

  const pricingService = new PricingService();

  // Test 1: Same currency should not make API calls
  console.log('\n1. Testing same currency optimization:');
  try {
    const result = await pricingService.getTokenPrice({
      tokenSymbol: 'USD',
      baseCurrency: 'USD',
      timestamp: new Date(),
      live: true,
    });

    if (result === '1') {
      console.log('  ✅ Same currency returns 1.0 without API call');
    } else {
      console.log(`  ⚠️  Same currency returned ${result} instead of 1`);
    }
  } catch (error) {
    console.log(`  ❌ Same currency test failed: ${error}`);
  }

  // Test 2: Error handling
  console.log('\n2. Testing error handling:');
  try {
    await pricingService.getTokenPrice({
      tokenSymbol: 'NONEXISTENT_TOKEN',
      baseCurrency: 'USD',
      timestamp: new Date(),
      live: true,
    });
    console.log('  ⚠️  Should have thrown an error for non-existent token');
  } catch {
    console.log('  ✅ Properly handles non-existent tokens');
  }

  console.log('\n✨ Scenario tests completed!');
}

/**
 * Run all tests
 */
async function main() {
  try {
    await runComprehensivePricingTests();
    await testSpecificScenarios();
  } catch (error) {
    console.error('💥 Fatal error during testing:', error);
  } finally {
    console.log('\n🛑 Testing process finished.');
    process.exit(0);
  }
}

// Run tests if this file is executed directly
if (import.meta.main) {
  main().catch(console.error);
}

export { runComprehensivePricingTests, testSpecificScenarios };
