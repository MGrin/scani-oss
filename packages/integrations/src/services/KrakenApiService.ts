/**
 * KrakenApiService
 *
 * Handles Kraken API communications for API Key authentication:
 * - Account balance retrieval
 * - API key validation via signed requests
 * - Asset information fetching
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

/**
 * Kraken asset balance
 */
interface KrakenBalance {
  [asset: string]: string;
}

/**
 * Kraken API Service
 * Based on Kraken REST API documentation: https://docs.kraken.com/api/docs/guides/global-intro
 */
export class KrakenApiService {
  private readonly baseUrl: string;
  private readonly rateLimiter?: RateLimiter;

  /**
   * API version for Kraken
   */
  private readonly API_VERSION = '0';

  /**
   * Last-issued nonce. Kraken enforces strictly-increasing nonces per API
   * key; if two requests from the same process land in the same
   * microsecond (or if wall-clock has gone backwards on a VM resume),
   * the counter makes sure the next value is always larger than the
   * previous one.
   */
  private lastNonce = 0n;

  constructor(baseUrl: string, rateLimiter?: RateLimiter) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Generate a strictly-increasing 19-digit microsecond nonce.
   *
   * `Date.now()` (ms) is too coarse — back-to-back calls in the same
   * millisecond produce duplicates, and mixing a 13-digit `Date.now()`
   * with a 16-digit micro-nonce (as we accidentally did before) causes
   * the new nonce to be numerically smaller than the last stored one →
   * Kraken returns `EAPI:Invalid nonce`. Unifying on a single 19-digit
   * `ms * 10^6 + microsecond-drift` format keeps every call forward-
   * compatible. The instance `lastNonce` guarantees strict monotonicity
   * within a single process.
   */
  private nextNonce(): string {
    const micros = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
    const next = micros > this.lastNonce ? micros : this.lastNonce + 1n;
    this.lastNonce = next;
    return next.toString();
  }

  /**
   * Create signature for authenticated Kraken API requests
   * Based on: https://docs.kraken.com/api/docs/guides/spot-rest-auth
   * @private
   */
  private createSignature(
    path: string,
    nonce: string,
    postData: string,
    apiSecret: string
  ): string {
    // Decode base64 secret
    const secretBuffer = Buffer.from(apiSecret, 'base64');

    // Create SHA256 hash of nonce + postData
    const hash = crypto.createHash('sha256');
    hash.update(nonce + postData);
    const hashDigest = hash.digest();

    // Create HMAC SHA512
    const hmac = crypto.createHmac('sha512', secretBuffer);
    hmac.update(path);
    hmac.update(hashDigest);

    return hmac.digest('base64');
  }

  /**
   * Validate API Key and Secret by making a balance query.
   *
   * Throws on any failure with the actual Kraken error string (e.g.
   * `EAPI:Invalid signature`, `EAPI:Invalid nonce`, `EAPI:Invalid key`,
   * `EGeneral:Permission denied`). Previously the function swallowed
   * everything as `false`, which made debugging blind — the UI just
   * showed "Invalid credentials" for signature bugs, nonce collisions,
   * and missing permissions alike.
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const subKey = credentialBucketKey(apiKey);
    const nonce = this.nextNonce();
    const path = `/${this.API_VERSION}/private/Balance`;
    const postData = `nonce=${nonce}`;

    let secretBuffer: Buffer;
    try {
      secretBuffer = Buffer.from(apiSecret.trim(), 'base64');
      if (secretBuffer.length === 0) throw new Error('empty');
    } catch {
      throw new Error(
        'API secret is not valid base64. Copy it exactly as Kraken shows it — no wrapping, no leading/trailing whitespace.'
      );
    }

    const signature = this.createSignatureWithBuffer(path, nonce, postData, secretBuffer);

    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'API-Key': apiKey.trim(),
            'API-Sign': signature,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'scani/1.0',
          },
          body: postData,
        }),
      subKey
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Kraken HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const data = (await response.json()) as { error?: string[] };
    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken rejected request: ${data.error.join('; ')}`);
    }
    return true;
  }

  private createSignatureWithBuffer(
    path: string,
    nonce: string,
    postData: string,
    secretBuffer: Buffer
  ): string {
    const hash = crypto.createHash('sha256');
    hash.update(nonce + postData);
    const hashDigest = hash.digest();
    const hmac = crypto.createHmac('sha512', secretBuffer);
    hmac.update(path);
    hmac.update(hashDigest);
    return hmac.digest('base64');
  }

  /**
   * Get account balances using API key authentication
   * Returns balances for all assets in the account
   */
  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; balance: string }>> {
    const subKey = credentialBucketKey(apiKey);
    try {
      const nonce = this.nextNonce();
      const path = `/${this.API_VERSION}/private/Balance`;
      const postData = `nonce=${nonce}`;

      const signature = this.createSignature(path, nonce, postData, apiSecret);

      const response = await this.executeWithRateLimit(
        () =>
          fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'API-Key': apiKey,
              'API-Sign': signature,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: postData,
          }),
        subKey
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        error?: string[];
        result?: KrakenBalance;
      };

      if (data.error && data.error.length > 0) {
        throw new Error(`Kraken API error: ${data.error.join(', ')}`);
      }

      if (!data.result) {
        return [];
      }

      // Convert object to array format
      return Object.entries(data.result).map(([asset, balance]) => ({
        asset,
        balance,
      }));
    } catch (error) {
      throw new Error(
        `Failed to fetch balances: ${error instanceof Error ? error.message : 'Unknown error'}`
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
