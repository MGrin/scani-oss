/**
 * Binance Integration Factory
 *
 * Provides factory functions for creating and validating Binance integrations
 * without exposing implementation details to consumers
 */

import { binanceRateLimiter } from '../rate-limiters/binance';
import { BinanceApiService } from '../services/BinanceApiService';

/**
 * Create a BinanceApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createBinanceApiService(): BinanceApiService {
  const baseUrl = process.env.BINANCE_API_BASE_URL || 'https://api.binance.com';
  return new BinanceApiService(baseUrl, binanceRateLimiter);
}

/**
 * Validate Binance API credentials
 *
 * @param apiKey - Binance API Key
 * @param apiSecret - Binance API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateBinanceCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createBinanceApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}

/**
 * Detect which Binance account types are available
 *
 * @param apiKey - Binance API Key
 * @param apiSecret - Binance API Secret
 * @returns Promise with detection results for SPOT, MARGIN, and FUTURES accounts
 */
export async function detectBinanceAccountTypes(apiKey: string, apiSecret: string) {
  const service = createBinanceApiService();
  return await service.detectAccountTypes(apiKey, apiSecret);
}
