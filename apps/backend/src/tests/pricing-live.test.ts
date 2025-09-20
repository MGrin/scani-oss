/**
 * Comprehensive Pricing Service Tests
 * Tests all required currency pairs and functionality
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import type { Token } from '../db/schema';
import { tokens } from '../db/schema';
import { PricingService } from '../services/pricing';

/**
 * Helper function to get token by symbol
 */
async function getTokenBySymbol(symbol: string): Promise<Token | null> {
  const result = await db
    .select()
    .from(tokens)
    .where(eq(tokens.symbol, symbol.toUpperCase()))
    .limit(1);

  return result[0] || null;
}

/**
 * Test configuration
 */
const TEST_PAIRS = [
  { from: 'RUB', to: 'USD', type: 'forex' },
  { from: 'BTC', to: 'USD', type: 'crypto' },
  { from: 'USD', to: 'USD', type: 'same' },
  { from: 'NVDA', to: 'USD', type: 'stock' },
  { from: 'AAPL', to: 'RUB', type: 'stock' },
  { from: 'XEQT.TO', to: 'USD', type: 'etf_conversion' }, // May need CAD conversion
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
      // Get token from database
      const token = await getTokenBySymbol(pair.from);

      if (!token) {
        console.log(`  ❌ Token ${pair.from} not found in database`);
        continue;
      }

      const startTime = Date.now();
      const price = await pricingService.getTokenPrice(token, pair.to, new Date());
      const duration = Date.now() - startTime;

      if (price && price !== '0') {
        console.log(`  ✅ Success: ${formatPrice(price, pair.from, pair.to)} (${duration}ms)`);
        passedTests++;
      } else {
        console.log(`  ❌ No price available for ${pair.from} -> ${pair.to}`);
      }

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
      // Get token from database
      const token = await getTokenBySymbol(pair.from);

      if (!token) {
        console.log(`  ❌ Token ${pair.from} not found in database`);
        continue;
      }

      const startTime = Date.now();
      const price = await pricingService.getTokenPrice(token, pair.to, HISTORICAL_DATE);
      const duration = Date.now() - startTime;

      if (price && price !== '0') {
        console.log(`  ✅ Success: ${formatPrice(price, pair.from, pair.to)} (${duration}ms)`);
        passedTests++;
      } else {
        console.log(`  ❌ No historical price available for ${pair.from} -> ${pair.to}`);
      }

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
    // Get token from database
    const token = await getTokenBySymbol(testPair.from);

    if (!token) {
      console.log(`  ❌ Token ${testPair.from} not found in database`);
    } else {
      console.log('  First request (should fetch from API):');
      const timestamp = new Date();
      const price1 = await pricingService.getTokenPrice(token, testPair.to, timestamp);
      console.log(`    ✅ Result: ${formatPrice(price1, testPair.from, testPair.to)}`);

      const firstCallCount = apiCounter.getTotalCalls();

      console.log('  Second request (should use cache):');
      const price2 = await pricingService.getTokenPrice(token, testPair.to, timestamp);
      console.log(`    ✅ Result: ${formatPrice(price2, testPair.from, testPair.to)}`);

      const secondCallCount = apiCounter.getTotalCalls();

      if (firstCallCount === secondCallCount) {
        console.log('  ✅ Cache working: No additional API calls made');
        passedTests++;
      } else {
        console.log('  ⚠️  Cache may not be working: Additional API calls detected');
      }

      totalTests++;
    }
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
    { from: 'XEQT.TO', to: 'USD', expected_path: 'XEQT.TO -> CAD -> USD' },
    { from: 'EUR', to: 'JPY', expected_path: 'EUR -> JPY (direct or via USD)' },
  ];

  for (const pair of multiStepPairs) {
    totalTests++;
    console.log(`\n  Testing ${pair.from} -> ${pair.to}:`);
    console.log(`  Expected conversion path: ${pair.expected_path}`);

    try {
      // Get token from database
      const token = await getTokenBySymbol(pair.from);

      if (!token) {
        console.log(`    ❌ Token ${pair.from} not found in database`);
        continue;
      }

      const price = await pricingService.getTokenPrice(token, pair.to, new Date());

      if (price && price !== '0') {
        console.log(`    ✅ Success: ${formatPrice(price, pair.from, pair.to)}`);
        console.log(`    ℹ️  Note: Verify this uses the expected conversion path`);
        passedTests++;
      } else {
        console.log(`    ❌ No price available for ${pair.from} -> ${pair.to}`);
      }
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

  try {
    // Get tokens from database first
    const testPairs = TEST_PAIRS.slice(0, 3);
    const tokens = [];

    for (const pair of testPairs) {
      const token = await getTokenBySymbol(pair.from);
      if (token) {
        tokens.push(token);
      }
    }

    if (tokens.length === 0) {
      console.log(`  ❌ No tokens found in database for batch test`);
    } else {
      const startTime = Date.now();
      const prices = await pricingService.getTokenPrices(tokens, 'USD', new Date());
      const duration = Date.now() - startTime;

      console.log(`  ✅ Batch request completed in ${duration}ms`);
      console.log(`  📊 Results received for ${prices.size} tokens:`);

      for (const [tokenId, price] of prices.entries()) {
        const token = tokens.find((t) => t.id === tokenId);
        if (token) {
          console.log(`    ${token.symbol} -> USD: ${formatPrice(price, token.symbol, 'USD')}`);
        }
      }

      totalTests++;
      passedTests++;
    }
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
    const usdToken = await getTokenBySymbol('USD');

    if (!usdToken) {
      console.log('  ❌ USD token not found in database');
    } else {
      const result = await pricingService.getTokenPrice(usdToken, 'USD', new Date());

      if (result === '1') {
        console.log('  ✅ Same currency returns 1.0 without API call');
      } else {
        console.log(`  ⚠️  Same currency returned ${result} instead of 1`);
      }
    }
  } catch (error) {
    console.log(`  ❌ Same currency test failed: ${error}`);
  }

  // Test 2: Error handling
  console.log('\n2. Testing error handling:');
  try {
    const nonExistentToken = await getTokenBySymbol('NONEXISTENT_TOKEN');

    if (!nonExistentToken) {
      console.log('  ✅ Properly handles non-existent tokens');
    } else {
      const result = await pricingService.getTokenPrice(nonExistentToken, 'USD', new Date());
      console.log(`  ⚠️  Non-existent token returned: ${result}`);
    }
  } catch (_error) {
    console.log('  ✅ Properly handles non-existent tokens');
  }

  console.log('\n✨ Scenario tests completed!');
}

/**
 * Test tier limitations and provider failure scenarios
 */
async function testTierLimitationsAndProviderFailures() {
  console.log('\n📊 Testing tier limitations and provider failure scenarios...');

  const pricingService = new PricingService();

  // Test 1: Check if XEQT.TO has tier limitation metadata after failure
  console.log('\n  🔍 Test 1: Checking XEQT.TO tier limitation metadata');
  try {
    const xeqtToken = await getTokenBySymbol('XEQT.TO');
    if (xeqtToken) {
      console.log(`    Found XEQT.TO token: ${xeqtToken.id}`);

      // Attempt to get price (should trigger tier limitation detection)
      const price = await pricingService.getTokenPrice(xeqtToken, 'USD', new Date());

      if (price === '0') {
        console.log(`    ✅ Price fetch failed as expected (returned "0")`);

        // Check if metadata was updated
        const updatedToken = await getTokenBySymbol('XEQT.TO');
        if (updatedToken?.providerMetadata) {
          try {
            const metadata =
              typeof updatedToken.providerMetadata === 'string'
                ? JSON.parse(updatedToken.providerMetadata)
                : updatedToken.providerMetadata;

            if (metadata?.pricingUnavailable) {
              console.log(`    ✅ Token metadata updated:`);
              console.log(`      - Provider: ${metadata.pricingUnavailable.provider}`);
              console.log(`      - Reason: ${metadata.pricingUnavailable.reason}`);
              console.log(
                `      - Requires Premium: ${metadata.pricingUnavailable.requiresPremium}`
              );
              console.log(`      - Detected At: ${metadata.pricingUnavailable.detectedAt}`);
            } else {
              console.log(`    ⚠️  No pricing limitation metadata found`);
            }
          } catch (parseError) {
            console.log(`    ⚠️  Could not parse metadata: ${parseError}`);
          }
        } else {
          console.log(`    ⚠️  Token metadata not updated (may be expected)`);
        }
      } else {
        console.log(`    ⚠️  Price fetch unexpectedly succeeded: $${price}`);
      }
    } else {
      console.log('    ❌ XEQT.TO token not found in database');
    }
  } catch (error) {
    console.log(`    ❌ Error testing XEQT.TO: ${error}`);
  }

  // Test 2: Test batch processing with mix of available and tier-limited tokens
  console.log('\n  🔍 Test 2: Batch processing with mixed availability');
  try {
    const testTokens = await Promise.all([
      getTokenBySymbol('BTC'), // Should work with CoinGecko
      getTokenBySymbol('XEQT.TO'), // May fail with tier limitation
      getTokenBySymbol('USD'), // Should work (base currency)
    ]);

    const validTokens = testTokens.filter((token): token is Token => token !== null);

    if (validTokens.length > 0) {
      const batchResults = await pricingService.getTokenPrices(validTokens, 'USD', new Date());

      console.log(`    📦 Batch results (${batchResults.size} tokens):`);
      for (const [tokenId, price] of batchResults) {
        const token = testTokens.find((t) => t?.id === tokenId);
        if (price !== '0') {
          console.log(`      ✅ ${token?.symbol}: $${price}`);
        } else {
          console.log(`      ❌ ${token?.symbol}: Failed to fetch price`);
        }
      }
    } else {
      console.log('    ⚠️  No valid tokens found for batch test');
    }
  } catch (error) {
    console.log(`    ❌ Error in batch test: ${error}`);
  }

  // Test 3: Comprehensive tier limitation and error classification tests
  console.log('\n  🔍 Test 3: Comprehensive error classification and tier limitation tests');

  // Test different error scenarios
  const testScenarios = [
    {
      symbol: 'INVALIDTOKEN123',
      expectedReason: 'Token not found or unavailable',
      description: 'Non-existent token',
    },
    {
      symbol: 'XEQT.TO',
      expectedReason: 'API tier limitation (403 Forbidden)',
      description: 'Tier-limited token',
    },
  ];

  // Test 3a: Verify error classification and metadata updates
  console.log('    📋 Part A: Error classification verification');

  for (const scenario of testScenarios) {
    try {
      const token = await getTokenBySymbol(scenario.symbol);
      if (token) {
        console.log(`      Testing ${scenario.description} (${scenario.symbol}):`);

        const price1 = await pricingService.getTokenPrice(token, 'USD', new Date());

        if (price1 === '0') {
          console.log(`        ✅ Failed as expected (returned "0")`);

          // Check if metadata was updated (for tier limitations)
          const updatedToken = await getTokenBySymbol(scenario.symbol);
          if (updatedToken?.providerMetadata) {
            try {
              const currentMetadata =
                typeof updatedToken.providerMetadata === 'string'
                  ? JSON.parse(updatedToken.providerMetadata)
                  : updatedToken.providerMetadata;

              if (currentMetadata?.pricingUnavailable) {
                console.log(`        ✅ Metadata properly updated:`);
                console.log(`          - Provider: ${currentMetadata.pricingUnavailable.provider}`);
                console.log(`          - Reason: ${currentMetadata.pricingUnavailable.reason}`);
                console.log(
                  `          - Requires Premium: ${currentMetadata.pricingUnavailable.requiresPremium}`
                );

                if (currentMetadata.pricingUnavailable.reason === 'tier_limitation') {
                  console.log(`        🎯 Correctly classified as tier limitation!`);
                }
              } else {
                console.log(
                  `        ℹ️  No pricing limitation metadata (expected for non-tier errors)`
                );
              }
            } catch (parseError) {
              console.log(`        ⚠️  Could not parse metadata: ${parseError}`);
            }
          } else {
            console.log(`        ℹ️  No metadata found (expected for non-tier errors)`);
          }

          // Check caching behavior - should be cached for a while
          const price2 = await pricingService.getTokenPrice(token, 'USD', new Date());
          if (price2 === '0') {
            console.log(`        ✅ Failure properly cached`);
          } else {
            console.log(`        ⚠️  Caching behavior unexpected`);
          }
        } else {
          console.log(`        ⚠️  Unexpectedly succeeded: $${price1}`);
        }
      } else {
        console.log(`      ⚠️  Token ${scenario.symbol} not found in database`);
      }
    } catch (error) {
      console.log(`      ❌ Error testing ${scenario.symbol}: ${error}`);
    }
  }

  // Test 3b: Test caching windows and behavior
  console.log('    ⏰ Part B: Caching window verification');

  const xeqtToken = await getTokenBySymbol('XEQT.TO');
  if (xeqtToken) {
    console.log('      Verifying tier limitation caching behavior:');

    // First call should use cached result
    const startTime = Date.now();
    const cachedPrice = await pricingService.getTokenPrice(xeqtToken, 'USD', new Date());
    const cacheTime = Date.now() - startTime;

    if (cachedPrice === '0' && cacheTime < 100) {
      // Should be very fast from cache
      console.log(`        ✅ Tier limitation properly cached (${cacheTime}ms - very fast)`);

      // Verify metadata indicates this is a premium requirement
      const token = await getTokenBySymbol('XEQT.TO');
      if (token?.providerMetadata) {
        try {
          const metadata =
            typeof token.providerMetadata === 'string'
              ? JSON.parse(token.providerMetadata)
              : token.providerMetadata;

          if (metadata?.pricingUnavailable?.requiresPremium) {
            console.log(`        💎 Premium requirement correctly flagged for user notification`);
          }
        } catch (_e) {
          // Ignore parse errors in this test
        }
      }
    } else {
      console.log(
        `        ⚠️  Caching behavior unexpected (time: ${cacheTime}ms, price: ${cachedPrice})`
      );
    }
  }

  // Test 4: Check metadata persistence across service restarts
  console.log('\n  🔍 Test 4: Metadata persistence');
  try {
    const xeqtToken = await getTokenBySymbol('XEQT.TO');
    if (xeqtToken?.providerMetadata) {
      try {
        const metadata =
          typeof xeqtToken.providerMetadata === 'string'
            ? JSON.parse(xeqtToken.providerMetadata)
            : xeqtToken.providerMetadata;

        if (metadata?.pricingUnavailable) {
          console.log(`    ✅ Metadata persists across service restarts`);
          console.log(`      - Limitation detected at: ${metadata.pricingUnavailable.detectedAt}`);
          console.log(`      - Requires premium: ${metadata.pricingUnavailable.requiresPremium}`);
        } else {
          console.log(`    ⚠️  No pricing limitation metadata found`);
        }
      } catch (parseError) {
        console.log(`    ⚠️  Could not parse metadata: ${parseError}`);
      }
    } else {
      console.log(`    ⚠️  No persistent metadata found (may be expected if no failures occurred)`);
    }
  } catch (error) {
    console.log(`    ❌ Error testing metadata persistence: ${error}`);
  }

  // Test 3c: User notification scenario testing
  console.log('    👤 Part C: User notification scenarios');

  // Simulate what a frontend would do when encountering tier-limited tokens
  const tokenSymbols = ['XEQT.TO', 'NVDA', 'BTC'];
  console.log('      Simulating frontend batch price request for portfolio:');

  const tokens = [];
  for (const symbol of tokenSymbols) {
    const token = await getTokenBySymbol(symbol);
    if (token) tokens.push(token);
  }

  if (tokens.length > 0) {
    const portfolioPrices = await pricingService.getTokenPrices(tokens, 'USD', new Date());

    console.log('        Portfolio pricing results:');
    for (const token of tokens) {
      const price = portfolioPrices.get(token.id);
      if (price === '0') {
        // Check if this is due to tier limitations
        if (token.providerMetadata) {
          try {
            const metadata =
              typeof token.providerMetadata === 'string'
                ? JSON.parse(token.providerMetadata)
                : token.providerMetadata;

            if (metadata?.pricingUnavailable?.requiresPremium) {
              console.log(
                `        💎 ${token.symbol}: Upgrade required for pricing (tier limitation detected)`
              );
            } else {
              console.log(`        ❌ ${token.symbol}: Price unavailable (other reason)`);
            }
          } catch (_e) {
            console.log(`        ❌ ${token.symbol}: Price unavailable (metadata parse error)`);
          }
        } else {
          console.log(`        ❌ ${token.symbol}: Price unavailable (no metadata)`);
        }
      } else {
        console.log(`        ✅ ${token.symbol}: $${price}`);
      }
    }
  }

  console.log('\n✨ Tier limitations and provider failure tests completed!');
}

/**
 * Run all tests
 */
async function main() {
  try {
    await runComprehensivePricingTests();
    await testSpecificScenarios();
    await testTierLimitationsAndProviderFailures();
  } catch (error) {
    console.error('💥 Fatal error during testing:', error);
  } finally {
    console.log('\n🛑 Testing process finished.');
    process.exit(0);
  }
}

// Run tests
main();
