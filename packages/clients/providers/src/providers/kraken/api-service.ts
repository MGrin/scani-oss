/**
 * `KrakenApiService` — thin HTTP + signing layer for Kraken's REST API.
 *
 * Owns:
 *   - HMAC-SHA512 signature generation per Kraken spec
 *     (https://docs.kraken.com/api/docs/guides/spot-rest-auth).
 *   - Strictly-increasing 19-digit microsecond nonce per process,
 *     guarded by a counter so multi-microsecond bursts and clock
 *     resumes don't trip `EAPI:Invalid nonce`.
 *   - Per-API-key sub-bucket rate-limiting via
 *     `credentialBucketKey(apiKey)`. Multiple users sharing one
 *     limiter namespace get isolated counters that match Kraken's
 *     per-key decaying-counter model.
 *   - Exponential backoff on `EAPI:Rate limit exceeded` for the
 *     paginated `Ledgers` endpoint (5s/10s/20s/40s).
 */

import crypto from 'node:crypto';
import { credentialBucketKey, type OutflowRateLimiter } from '@scani/rate-limiter';

const API_VERSION = '0';

export interface KrakenLedgerEntry {
  refid: string;
  /** Unix seconds (fractional allowed). */
  time: number;
  /**
   * 'trade' | 'deposit' | 'withdrawal' | 'transfer' | 'margin' |
   * 'rollover' | 'spend' | 'receive' | 'settled' | 'adjustment' |
   * 'staking' | 'earn' | 'reward' | …
   */
  type: string;
  subtype?: string;
  aclass: string;
  asset: string;
  /** Signed; positive = inflow, negative = outflow. */
  amount: string;
  /** Always positive. */
  fee: string;
  balance: string;
}

export class KrakenApiService {
  private lastNonce = 0n;

  constructor(
    private readonly baseUrl: string,
    private readonly limiter: OutflowRateLimiter
  ) {}

  /**
   * 19-digit microsecond nonce, strictly monotonic per process.
   *
   * `Date.now()` (ms) is too coarse — back-to-back calls in the same
   * millisecond produce duplicates. `process.hrtime.bigint()` gives
   * sub-microsecond resolution; the `lastNonce` counter ensures we
   * always advance even across clock anomalies (VM resume, NTP step).
   */
  private nextNonce(): string {
    const micros = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
    const next = micros > this.lastNonce ? micros : this.lastNonce + 1n;
    this.lastNonce = next;
    return next.toString();
  }

  private createSignature(
    path: string,
    nonce: string,
    postData: string,
    apiSecret: string
  ): string {
    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const hash = crypto.createHash('sha256');
    hash.update(nonce + postData);
    const hashDigest = hash.digest();
    const hmac = crypto.createHmac('sha512', secretBuffer);
    hmac.update(path);
    hmac.update(hashDigest);
    return hmac.digest('base64');
  }

  /**
   * Validate `(apiKey, apiSecret)` by issuing a `/private/Balance`
   * call. Throws with the actual Kraken error string on failure
   * (e.g. `EAPI:Invalid signature`, `EAPI:Invalid nonce`,
   * `EGeneral:Permission denied`) — much more useful than the
   * pre-refactor "always returns false on error" pattern.
   */
  async validateApiKey(apiKey: string, apiSecret: string): Promise<boolean> {
    const trimmedSecret = apiSecret.trim();
    let secretBuffer: Buffer;
    try {
      secretBuffer = Buffer.from(trimmedSecret, 'base64');
      if (secretBuffer.length === 0) throw new Error('empty');
    } catch {
      throw new Error(
        'API secret is not valid base64. Copy it exactly as Kraken shows it — no wrapping, no leading/trailing whitespace.'
      );
    }

    const subKey = credentialBucketKey(apiKey);
    const nonce = this.nextNonce();
    const path = `/${API_VERSION}/private/Balance`;
    const postData = `nonce=${nonce}`;
    const signature = this.createSignature(path, nonce, postData, trimmedSecret);

    const response = await this.limiter.execute(
      async () =>
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

  async getBalances(
    apiKey: string,
    apiSecret: string
  ): Promise<Array<{ asset: string; balance: string }>> {
    const subKey = credentialBucketKey(apiKey);
    const nonce = this.nextNonce();
    const path = `/${API_VERSION}/private/Balance`;
    const postData = `nonce=${nonce}`;
    const signature = this.createSignature(path, nonce, postData, apiSecret);

    const response = await this.limiter.execute(
      async () =>
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as {
      error?: string[];
      result?: Record<string, string>;
    };
    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(', ')}`);
    }
    if (!data.result) return [];
    return Object.entries(data.result).map(([asset, balance]) => ({ asset, balance }));
  }

  /**
   * Paginated `/private/Ledgers` fetch with backoff on
   * `EAPI:Rate limit exceeded`. Kraken weights this endpoint at 2
   * counter units per call; the counter drains slowly enough that
   * the in-process limiter alone doesn't always prevent the error,
   * so we retry with exponential backoff.
   */
  async fetchLedgers(
    apiKey: string,
    apiSecret: string,
    opts: { start?: number; end?: number; ofs?: number } = {}
  ): Promise<{ ledger: Record<string, KrakenLedgerEntry>; count: number }> {
    const backoffsMs = [5_000, 10_000, 20_000, 40_000];
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
      try {
        return await this.fetchLedgersOnce(apiKey, apiSecret, opts);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!/EAPI:Rate limit exceeded/.test(msg)) throw error;
        lastError = error instanceof Error ? error : new Error(msg);
        if (attempt === backoffsMs.length) break;
        const waitMs = backoffsMs[attempt] ?? 5_000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError ?? new Error('Kraken Ledgers: exhausted retries');
  }

  private async fetchLedgersOnce(
    apiKey: string,
    apiSecret: string,
    opts: { start?: number; end?: number; ofs?: number }
  ): Promise<{ ledger: Record<string, KrakenLedgerEntry>; count: number }> {
    const subKey = credentialBucketKey(apiKey);
    const nonce = this.nextNonce();
    const path = `/${API_VERSION}/private/Ledgers`;

    const params = new URLSearchParams();
    params.set('nonce', nonce);
    if (opts.start !== undefined) params.set('start', String(opts.start));
    if (opts.end !== undefined) params.set('end', String(opts.end));
    if (opts.ofs !== undefined) params.set('ofs', String(opts.ofs));
    const postData = params.toString();
    const signature = this.createSignature(path, nonce, postData, apiSecret);

    const response = await this.limiter.execute(
      async () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'API-Key': apiKey,
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
    const data = (await response.json()) as {
      error?: string[];
      result?: { ledger?: Record<string, KrakenLedgerEntry>; count?: number };
    };
    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken Ledgers error: ${data.error.join('; ')}`);
    }
    return {
      ledger: data.result?.ledger ?? {},
      count: data.result?.count ?? 0,
    };
  }
}
