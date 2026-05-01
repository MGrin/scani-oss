/**
 * `ProviderError` is the canonical error type providers throw to
 * communicate machine-readable failure semantics to orchestrators.
 *
 * Orchestrators (TransactionImportCoordinator,
 * HistoricalPriceBackfillService, the credential pool) pattern-match
 * on `kind` to decide retry / backoff / quarantine behavior:
 *
 *   - `auth-failed` — credentials are bad. Quarantine the credential
 *     in the pool; surface to the user as "needs reconnection". Don't
 *     retry.
 *   - `rate-limited` — provider returned a 429 / quota error. Sleep
 *     for the namespace's window then retry. Pool entry quarantined
 *     for the same window.
 *   - `retryable` — generic transient (5xx, network blip). Caller
 *     decides to retry; pool tracks failures but doesn't quarantine.
 *   - `unrecoverable` — bad input or known-permanent failure. Don't
 *     retry; surface to the user.
 *   - `not-supported` — provider doesn't know about this token /
 *     institution / capability. Caller falls through to the next
 *     provider.
 *
 * Concrete providers should classify their HTTP/SDK errors into these
 * kinds before throwing. Generic Error instances bubbling up from a
 * provider get treated as `retryable` by default.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth-failed' | 'rate-limited' | 'retryable' | 'unrecoverable' | 'not-supported',
    readonly providerKey?: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }

  /**
   * Build a ProviderError from a non-2xx Response. Maps status codes to
   * the canonical `kind` so every provider's HTTP error wrapping is
   * uniform. Subclasses of `BaseHmacCexProvider` invoke this via the
   * shared `signedFetch` path.
   */
  static fromHttp(providerKey: string, res: Response, body?: string): ProviderError {
    const suffix = body ? ` — ${body.slice(0, 200)}` : '';
    const message = `${providerKey} HTTP ${res.status}${suffix}`;
    if (res.status === 401 || res.status === 403) {
      return new ProviderError(message, 'auth-failed', providerKey);
    }
    if (res.status === 429) {
      return new ProviderError(message, 'rate-limited', providerKey);
    }
    if (res.status >= 500) {
      return new ProviderError(message, 'retryable', providerKey);
    }
    return new ProviderError(message, 'unrecoverable', providerKey);
  }
}

/**
 * Best-effort classifier for unstructured errors thrown by underlying
 * HTTP/SDK code. Pattern-matches on common error message shapes seen
 * in the wild (Kraken EAPI codes, generic HTTP status codes, etc.).
 * Returns `'retryable'` as the default — the orchestrator can override
 * based on context.
 */
export function classifyError(err: unknown): ProviderError['kind'] {
  if (err instanceof ProviderError) return err.kind;
  const msg = err instanceof Error ? err.message : String(err);

  if (/EAPI:Rate limit exceeded|429|rate.?limit/i.test(msg)) return 'rate-limited';
  if (/HTTP 40[13]|EAPI:Invalid (signature|nonce|key)|unauthor/i.test(msg)) {
    return 'auth-failed';
  }
  if (/IBKR Flex Query error \(code 10(10|12)\)/.test(msg)) return 'auth-failed';
  if (/IBKR Flex Query error \(code 1018\)/.test(msg)) return 'rate-limited';
  if (/HTTP 5\d{2}|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(msg)) {
    return 'retryable';
  }
  return 'retryable';
}
