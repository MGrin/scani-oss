import { config } from '../config/pricing';
import { TokenValidationService } from '../services/token-validation';

// Simple test of the Finnhub integration
async function testFinnhubIntegration() {
  console.log('🧪 Testing Finnhub Integration...\n');

  // Check if API key is configured
  if (!config.finnhub.apiKey) {
    console.log('❌ FINNHUB_API_KEY is not configured');
    console.log('💡 To test with real API, set FINNHUB_API_KEY in your environment');
    console.log('💡 Get a free API key at: https://finnhub.io/register\n');
    return;
  }

  console.log('✅ Finnhub API key is configured');
  console.log(`📍 Base URL: ${config.finnhub.baseUrl}\n`);

  // Test token validation service
  const validationService = new TokenValidationService();

  // Test with a known stock symbol
  console.log('🔍 Testing token validation with AAPL...');
  try {
    const result = await validationService.validateToken('AAPL');

    if (result.isValid) {
      console.log('✅ AAPL validation successful!');
      console.log(`📊 Symbol: ${result.metadata?.symbol}`);
      console.log(`📝 Name: ${result.metadata?.name}`);
      console.log(`🏷️ Type: ${result.metadata?.type}`);
      console.log(`💱 Currency: ${result.metadata?.currency}`);
      console.log(`🏢 Exchange: ${result.metadata?.exchange}`);
    } else {
      console.log('❌ AAPL validation failed:', result.error);
    }
  } catch (error) {
    console.log('❌ Error testing AAPL:', error instanceof Error ? error.message : error);
  }

  console.log('');

  // Test with an invalid symbol
  console.log('🔍 Testing token validation with INVALID...');
  try {
    const result = await validationService.validateToken('INVALID');

    if (!result.isValid) {
      console.log('✅ Invalid symbol correctly rejected:', result.error);
    } else {
      console.log('⚠️ Invalid symbol was accepted (unexpected)');
    }
  } catch (error) {
    console.log('❌ Error testing INVALID:', error instanceof Error ? error.message : error);
  }

  console.log('\n🎉 Finnhub integration test completed!');
}

// Run the test
testFinnhubIntegration().catch(console.error);
