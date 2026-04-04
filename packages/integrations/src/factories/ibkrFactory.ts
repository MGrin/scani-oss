/**
 * IBKR Integration Factory
 *
 * Provides factory functions for creating and validating IBKR integrations
 * without exposing implementation details to consumers
 */

import { ibkrRateLimiter } from '../rate-limiters/ibkr';
import { IbkrFlexQueryService } from '../services/IbkrFlexQueryService';

/**
 * Create an IbkrFlexQueryService instance
 * Uses global rate limiter to prevent exceeding IBKR API limits
 */
export function createIbkrFlexQueryService(): IbkrFlexQueryService {
  return new IbkrFlexQueryService(ibkrRateLimiter);
}

/**
 * Validate IBKR Flex Query credentials
 *
 * @param token - IBKR Flex Web Service Token
 * @param queryId - IBKR Flex Query ID
 * @returns Promise<boolean> - true if credentials are valid, false otherwise
 */
export async function validateIbkrCredentials(token: string, queryId: string): Promise<boolean> {
  const service = createIbkrFlexQueryService();
  return await service.validateCredentials(token, queryId);
}
