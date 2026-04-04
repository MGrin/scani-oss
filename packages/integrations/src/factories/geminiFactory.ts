/**
 * Gemini Integration Factory
 *
 * Provides factory functions for creating and validating Gemini integrations
 * without exposing implementation details to consumers
 */

import { geminiRateLimiter } from '../rate-limiters/gemini';
import { GeminiApiService } from '../services/GeminiApiService';

/**
 * Create a GeminiApiService instance
 * Uses global rate limiter to prevent exceeding API limits
 */
export function createGeminiApiService(): GeminiApiService {
  const baseUrl = process.env.GEMINI_API_BASE_URL || 'https://api.gemini.com';
  return new GeminiApiService(baseUrl, geminiRateLimiter);
}

/**
 * Validate Gemini API credentials
 *
 * @param apiKey - Gemini API Key
 * @param apiSecret - Gemini API Secret
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 * @throws Error if validation fails due to network or API issues
 */
export async function validateGeminiCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createGeminiApiService();
  return await service.validateApiKey(apiKey, apiSecret);
}
