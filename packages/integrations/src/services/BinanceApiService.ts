/**
 * BinanceApiService
 *
 * Handles Binance API communications for API Key authentication only:
 * - Account fetching
 * - Asset balance retrieval
 * - API key validation via signed requests
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Binance account information
 */
interface BinanceAccount {
  uid: number;
  accountType: 'SPOT' | 'MARGIN' | 'LENDING' | 'FUTURES' | string;
  permissions: string[];
}

/**
 * Available account types on Binance
 */
export type BinanceAccountType = 'SPOT' | 'MARGIN' | 'FUTURES';

/**
 * Result of account type detection
 */
export interface AccountTypesDetectionResult {
  availableTypes: BinanceAccountType[];
  spot: boolean;
  margin: boolean;
  futures: boolean;
}

/**
 * Binance asset/coin
 */
interface BinanceCoin {
  coin: string;
  depositAllEnable?: boolean;
  withdrawAllEnable?: boolean;
  name?: string;
  free: string;
  locked: string;
  freeze: string;
  withdrawing: string;
  ipoable: string;
  btcValuation: string;
  sponsoredMigrationStatus?: string;
  userAssetDrivenStatus?: string;
  operators?: unknown[];
  storage?: unknown;
  isLegalMoney?: boolean;
  trading?: boolean;
  symbol?: string;
  accountName?: string;
  memberEntity?: unknown;
}

/**
 * Binance account asset
 */
interface BinanceAccountAsset {
  asset: string;
  free: string;
  locked: string;
}

/**
 * Binance API Service
 */
export class BinanceApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  /**
   * Receive window for API requests in milliseconds
   * Binance requires timestamp within this window to prevent replay attacks
   */
  private readonly RECV_WINDOW = 5000;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Get user's trading accounts
   */
  async getAccounts(accessToken: string): Promise<BinanceAccount[]> {
    const subKey = credentialBucketKey(accessToken);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/sapi/v1/account/query/queryAccountByStatus`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      subKey
    );

    if (!response.ok) {
      const error = (await response.json()) as Record<string, unknown>;
      throw new Error(
        `Failed to fetch accounts: ${(error.message as string) || response.statusText}`
      );
    }

    const data = (await response.json()) as unknown;

    // Binance returns array of accounts
    if (Array.isArray(data)) {
      return data;
    }

    // Or might return an object with accounts array
    const dataObj = data as Record<string, unknown> | undefined;
    if (dataObj?.accounts && Array.isArray(dataObj.accounts)) {
      return dataObj.accounts as BinanceAccount[];
    }

    // Try to extract from response structure
    if (dataObj?.data && Array.isArray(dataObj.data)) {
      return dataObj.data as BinanceAccount[];
    }

    return [];
  }

  /**
   * Get user's account UID
   */
  async getAccountUid(accessToken: string): Promise<number> {
    const subKey = credentialBucketKey(accessToken);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/sapi/v1/account/apiKey/queryAccountUid`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      subKey
    );

    if (!response.ok) {
      const error = (await response.json()) as Record<string, unknown>;
      throw new Error(
        `Failed to fetch account UID: ${(error.message as string) || response.statusText}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Response structure: { uid: number } or { data: { uid: number } }
    if (typeof data.uid === 'number') {
      return data.uid;
    }

    const nestedData = data.data as Record<string, unknown> | undefined;
    if (nestedData && typeof nestedData.uid === 'number') {
      return nestedData.uid;
    }

    throw new Error('Unable to extract account UID from response');
  }

  /**
   * Get all assets for account (SPOT account)
   */
  async getSpotAssets(accessToken: string): Promise<BinanceCoin[]> {
    const subKey = credentialBucketKey(accessToken);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/sapi/v1/capital/config/getall`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      subKey
    );

    if (!response.ok) {
      const error = (await response.json()) as Record<string, unknown>;
      throw new Error(
        `Failed to fetch spot assets: ${(error.message as string) || response.statusText}`
      );
    }

    const data = (await response.json()) as unknown;

    // Response is array of coins
    if (Array.isArray(data)) {
      return data as BinanceCoin[];
    }

    // Or might be wrapped
    const dataObj = data as Record<string, unknown> | undefined;
    if (dataObj?.data && Array.isArray(dataObj.data)) {
      return dataObj.data as BinanceCoin[];
    }

    return [];
  }

  /**
   * Get spot account balances
   */
  async getSpotAccountBalances(accessToken: string): Promise<BinanceAccountAsset[]> {
    const subKey = credentialBucketKey(accessToken);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/sapi/v1/account`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      subKey
    );

    if (!response.ok) {
      const error = (await response.json()) as Record<string, unknown>;
      throw new Error(
        `Failed to fetch spot balances: ${(error.message as string) || response.statusText}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Response structure: { balances: BinanceAccountAsset[] }
    if (data.balances && Array.isArray(data.balances)) {
      return data.balances as BinanceAccountAsset[];
    }

    return [];
  }

  /**
   * Get margin account details
   */
  async getMarginAccountDetails(accessToken: string): Promise<{
    userAssets: BinanceAccountAsset[];
  }> {
    const subKey = credentialBucketKey(accessToken);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/sapi/v1/margin/account`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }),
      subKey
    );

    if (!response.ok) {
      const error = (await response.json()) as Record<string, unknown>;
      throw new Error(
        `Failed to fetch margin account: ${(error.message as string) || response.statusText}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Response structure: { userAssets: BinanceAccountAsset[] }
    if (data.userAssets && Array.isArray(data.userAssets)) {
      return data as { userAssets: BinanceAccountAsset[] };
    }

    return { userAssets: [] };
  }

  /**
   * Create signed query string for authenticated requests
   * @private
   */
  private createSignedQueryString(apiSecret: string, params: Record<string, unknown> = {}): string {
    const timestamp = Date.now();
    const allParams = {
      timestamp,
      recvWindow: this.RECV_WINDOW,
      ...params,
    };

    // Build query string
    const queryString = Object.entries(allParams)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    // Create HMAC SHA256 signature
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    return `${queryString}&signature=${signature}`;
  }

  /**
   * Validate API Key and Secret by making a simple API call
   * Uses createHmac from crypto to sign the request
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const queryString = this.createSignedQueryString(apiSecret);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/api/v3/account?${queryString}`, {
          headers: { 'X-MBX-APIKEY': apiKey },
        }),
      subKey
    );

    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Binance HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  /**
   * Get spot account balances using API key authentication
   * Returns balances for all assets in the spot account
   */
  async getSpotBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; free: string; locked: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const queryString = this.createSignedQueryString(apiSecret);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}/api/v3/account?${queryString}`, {
            headers: {
              'X-MBX-APIKEY': apiKey,
            },
          }),
        subKey
      );

      if (!response.ok) {
        const error = (await response.json()) as Record<string, unknown>;
        throw new Error(
          `Failed to fetch spot balances: ${(error.msg as string) || response.statusText}`
        );
      }

      const data = (await response.json()) as Record<string, unknown>;

      // Response structure: { balances: Array<{ asset, free, locked }> }
      if (data.balances && Array.isArray(data.balances)) {
        return data.balances as Array<{ asset: string; free: string; locked: string }>;
      }

      return [];
    } catch (error) {
      throw new Error(
        `Failed to fetch spot balances: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get margin account balances using API key authentication
   * Returns balances for all assets in the cross margin account
   */
  async getMarginBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; free: string; locked: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const queryString = this.createSignedQueryString(apiSecret);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}/sapi/v1/margin/account?${queryString}`, {
            headers: {
              'X-MBX-APIKEY': apiKey,
            },
          }),
        subKey
      );

      if (!response.ok) {
        const error = (await response.json()) as Record<string, unknown>;
        throw new Error(
          `Failed to fetch margin balances: ${(error.msg as string) || response.statusText}`
        );
      }

      const data = (await response.json()) as Record<string, unknown>;

      // Response structure: { userAssets: Array<{ asset, free, locked }> }
      if (data.userAssets && Array.isArray(data.userAssets)) {
        return data.userAssets as Array<{ asset: string; free: string; locked: string }>;
      }

      return [];
    } catch (error) {
      throw new Error(
        `Failed to fetch margin balances: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Detect which account types are available and have permissions
   * Tests each account type by making a simple API call
   *
   * @param apiKey - Binance API Key
   * @param apiSecret - Binance API Secret
   * @returns Object indicating which account types are available
   */
  async detectAccountTypes(
    apiKey: string,
    apiSecret: string
  ): Promise<AccountTypesDetectionResult> {
    const result: AccountTypesDetectionResult = {
      availableTypes: [],
      spot: false,
      margin: false,
      futures: false,
    };

    // Check SPOT account
    try {
      await this.getSpotBalances(apiKey, apiSecret);
      result.spot = true;
      result.availableTypes.push('SPOT');
    } catch (_error) {
      // SPOT not available or no permissions
    }

    // Check MARGIN account
    try {
      await this.getMarginBalances(apiKey, apiSecret);
      result.margin = true;
      result.availableTypes.push('MARGIN');
    } catch (_error) {
      // MARGIN not available or no permissions
    }

    // Check FUTURES account
    try {
      await this.getFuturesBalances(apiKey, apiSecret);
      result.futures = true;
      result.availableTypes.push('FUTURES');
    } catch (_error) {
      // FUTURES not available or no permissions
    }

    return result;
  }

  /**
   * Get futures account balances using API key authentication
   * Returns balances for all assets in the USDⓈ-M futures account
   */
  async getFuturesBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; free: string; locked: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const queryString = this.createSignedQueryString(apiSecret);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}/fapi/v2/balance?${queryString}`, {
            headers: {
              'X-MBX-APIKEY': apiKey,
            },
          }),
        subKey
      );

      if (!response.ok) {
        const error = (await response.json()) as Record<string, unknown>;
        throw new Error(
          `Failed to fetch futures balances: ${(error.msg as string) || response.statusText}`
        );
      }

      const data = (await response.json()) as unknown;

      // Response structure: Array<{ asset, availableBalance, balance }>
      if (Array.isArray(data)) {
        return data.map((item: { asset: string; availableBalance: string; balance: string }) => ({
          asset: item.asset,
          free: item.availableBalance,
          locked: (parseFloat(item.balance) - parseFloat(item.availableBalance)).toString(),
        }));
      }

      return [];
    } catch (error) {
      throw new Error(
        `Failed to fetch futures balances: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Execute function with rate limiting if configured. `subKey`
   * partitions the provider-wide bucket by credential hash.
   */
  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}
