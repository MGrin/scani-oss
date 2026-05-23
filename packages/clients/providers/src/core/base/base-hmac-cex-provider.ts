import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { credentialBucketKey, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { Capability, ProviderBase } from '../capabilities';
import { ProviderError } from '../errors';
import type { ProviderContext, WithUserCreds } from '../types';
import { fetchWithTimeout } from '../utils/fetch';

// Per-user credentials for any HMAC-signed CEX. Subclasses may extend.
export interface ApiKeyCreds {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

// Self-describing request a subclass hands to signedFetch / signedJson.
// The base attaches signing headers, runs through the rate limiter,
// dispatches through fetchWithTimeout, and wraps non-2xx as ProviderError.
export interface SignedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path component, leading slash, no host. */
  url: string;
  /** Query string already encoded (no leading "?"); empty when none. */
  query?: string;
  /** Body string (e.g. JSON.stringify(payload)); empty when none. */
  body?: string;
  /** Headers besides the signing ones the subclass produces. */
  extraHeaders?: Record<string, string>;
}

/**
 * Shared scaffolding for HMAC-signed CEX providers (Binance, Bybit, OKX,
 * Gate, Bitget, Bitstamp, KuCoin, MEXC, Huobi, Gemini, Coinbase, …).
 *
 * Sibling to `BaseCexProvider` (which owns pagination + asset-identity
 * mapping for venues like Kraken that use the streaming-history pattern).
 * Most CEX providers in the catalog only need balance fetches + creds
 * validation — that's what this base handles.
 *
 * Per-venue divergence on the wire is too wide to model declaratively
 * (digest hex vs base64, sha256 vs sha512, header names, pre-sign
 * payload order, body hashing, optional passphrase, OAuth bearer
 * variants). So this base owns only the parts that ARE uniform:
 *
 *   - Rate-limiter execution + per-credential bucket key.
 *   - HTTP dispatch through `fetchWithTimeout` (timeout + 429/5xx retry).
 *   - Non-2xx → `ProviderError.fromHttp` so the registry's classifier
 *     gets a structured `kind` instead of `new Error('X HTTP 401')`.
 *   - Per-user credential extraction from `ctx.resolveCredentials`.
 *
 * Subclasses provide:
 *   - `providerKey` + `capabilities` (the ProviderBase shape).
 *   - `baseUrl` — the venue's API origin (no trailing slash).
 *   - `signRequest(req, creds)` — return signing headers for a canonical
 *     request. This is where every venue's idiosyncratic signing math
 *     lives.
 */
export abstract class BaseHmacCexProvider implements ProviderBase {
  abstract readonly providerKey: string;
  abstract readonly capabilities: readonly Capability[];
  protected abstract readonly baseUrl: string;

  protected readonly logger: CustomLogger;
  protected readonly limiter: OutflowRateLimiter;

  constructor(limiter: OutflowRateLimiter) {
    this.limiter = limiter;
    this.logger = createComponentLogger(`provider:${this.constructor.name}`);
  }

  /** Build the venue-specific signing headers for a canonical request. */
  protected abstract signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string>;

  /**
   * Resolve apiKey + apiSecret (+ optional passphrase) from the
   * per-user credentials reference. Returns null when the credential
   * is absent or shaped wrong — subclasses gate on this and short-
   * circuit (typically returning `[]` or `{ valid: false }` for
   * validateCredentials).
   */
  protected async resolveApiCreds(
    ctx: WithUserCreds<ProviderContext>
  ): Promise<ApiKeyCreds | null> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return null;
    return {
      apiKey,
      apiSecret,
      passphrase: (creds.passphrase as string | undefined) ?? undefined,
    };
  }

  /**
   * Execute a signed request through the limiter + fetchWithTimeout.
   * Throws `ProviderError` (kind derived from HTTP status) on non-2xx.
   * `validateCredentials` paths catch the auth-failed kind to translate
   * into `{ valid: false }` rather than a thrown error.
   */
  protected async signedFetch(req: SignedRequest, creds: ApiKeyCreds): Promise<Response> {
    const subKey = credentialBucketKey(creds.apiKey);
    const headers = {
      ...this.signRequest(req, creds),
      ...(req.extraHeaders ?? {}),
    };
    const queryStr = req.query ? `?${req.query}` : '';
    const url = `${this.baseUrl}${req.url}${queryStr}`;

    return this.limiter.execute(async () => {
      const res = await fetchWithTimeout(url, {
        method: req.method,
        headers,
        body: req.body,
      });
      if (!res.ok) {
        let body: string | undefined;
        try {
          body = await res.text();
        } catch {}
        throw ProviderError.fromHttp(this.providerKey, res, body);
      }
      return res;
    }, subKey);
  }

  /** Convenience: signed request → parsed JSON. */
  protected async signedJson<T>(req: SignedRequest, creds: ApiKeyCreds): Promise<T> {
    const res = await this.signedFetch(req, creds);
    return (await res.json()) as T;
  }
}
