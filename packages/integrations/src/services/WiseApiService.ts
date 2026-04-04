/**
 * WiseApiService
 *
 * Handles Wise (TransferWise) API communications for API Key (Bearer token) authentication:
 * - Profile retrieval (personal and business)
 * - Multi-currency balance retrieval
 * - API token validation
 *
 * API docs: https://docs.wise.com/api-docs
 */

import type { RateLimiter } from '../types';

/**
 * Wise profile type
 */
export interface WiseProfile {
  id: number;
  type: 'PERSONAL' | 'BUSINESS';
  fullName: string;
}

/**
 * Wise balance amount
 */
interface WiseAmount {
  value: number;
  currency: string;
}

/**
 * Wise balance entry
 */
export interface WiseBalance {
  id: number;
  currency: string;
  amount: WiseAmount;
  type: string;
}

/**
 * Wise API Service
 * Based on Wise Personal API: https://docs.wise.com/api-docs
 */
export class WiseApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Validate API token by fetching profiles
   * A successful profiles response means the token is valid
   */
  async validateApiToken(apiToken: string): Promise<boolean> {
    try {
      const profiles = await this.getProfiles(apiToken);
      return profiles.length > 0;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get user profiles (personal and/or business)
   * GET /v2/profiles
   */
  async getProfiles(apiToken: string): Promise<WiseProfile[]> {
    try {
      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}/v2/profiles`, {
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
        })
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as unknown;

      if (!Array.isArray(data)) {
        return [];
      }

      return data as WiseProfile[];
    } catch (error) {
      throw new Error(
        `Failed to fetch profiles: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get multi-currency balances for a profile
   * GET /v4/profiles/{profileId}/balances?types=STANDARD
   */
  async getBalances(apiToken: string, profileId: number): Promise<WiseBalance[]> {
    try {
      const response = await this.executeWithRateLimit(() =>
        fetch(`${this.baseUrl}/v4/profiles/${profileId}/balances?types=STANDARD`, {
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
        })
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as unknown;

      if (!Array.isArray(data)) {
        return [];
      }

      return data as WiseBalance[];
    } catch (error) {
      throw new Error(
        `Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Execute function with rate limiting if configured
   */
  private async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn);
    }
    return fn();
  }
}
