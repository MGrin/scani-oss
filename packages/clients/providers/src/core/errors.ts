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
  /** HTTP status, when this error came from a non-2xx response. */
  readonly status?: number;

  /**
   * Raw response body. `message` carries a 200-char excerpt for humans;
   * this is what a provider pattern-matches its venue's error codes on,
   * because the difference between "this key has no Margin wallet" and
   * "the Margin call failed" is only ever in the body.
   */
  readonly body?: string;

  /**
   * How long the caller must leave this credential ALONE, when the provider
   * says so (SC-279).
   *
   * `kind: 'rate-limited'` on its own means "sleep the namespace window and
   * retry", which is right for a throughput limit and wrong for a lockout.
   * IBKR Flex code 1025 — "Too many failed attempts" — is triggered *by*
   * repeated failure, so a retry is not recovery, it is what sustains the
   * lockout: every attempt refreshes the counter that has to age out.
   *
   * When this is set the contract is stronger than backoff: **do not contact
   * the provider for this credential until the window has passed.** A caller
   * that merely delays and retries has not honoured it.
   */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    readonly kind: 'auth-failed' | 'rate-limited' | 'retryable' | 'unrecoverable' | 'not-supported',
    readonly providerKey?: string,
    options?: { cause?: unknown; status?: number; body?: string; retryAfterMs?: number }
  ) {
    super(message, options);
    this.name = 'ProviderError';
    this.status = options?.status;
    this.body = options?.body;
    this.retryAfterMs = options?.retryAfterMs;
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
    const details = { status: res.status, body };
    if (res.status === 401 || res.status === 403) {
      return new ProviderError(message, 'auth-failed', providerKey, details);
    }
    if (res.status === 429) {
      return new ProviderError(message, 'rate-limited', providerKey, details);
    }
    if (res.status >= 500) {
      return new ProviderError(message, 'retryable', providerKey, details);
    }
    return new ProviderError(message, 'unrecoverable', providerKey, details);
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

/**
 * A failed credential check is either a VERDICT or an OUTAGE, and only one of
 * them is about the credential (SC-445).
 *
 * Every `validateCredentials` in this package used to end in a catch-all that
 * turned both into `{ valid: false, message }`, so a 503, a timeout and a
 * rate-limit arrived at the connect form indistinguishable from a rejected
 * key — and the form says "your details were rejected". The reasonable
 * response to that is to go regenerate the credential and paste it again,
 * which fixes nothing and, on venues that count failed attempts, is what
 * sustains the lockout.
 *
 * The distinction is available in the evidence and needs no timeout to guess
 * at: a rejected credential is a service that RECOGNISED the request and
 * refused it — an HTTP 401/403, or a documented error code — which every
 * provider here already classifies as `auth-failed`. Anything else is us
 * failing to get an answer, and the only honest thing to say about the
 * credential then is nothing.
 *
 * So: `valid: false` means the service rejected it. Everything else is
 * re-thrown for the caller to classify by `kind` — `apps/backend/api`'s
 * `toCredentialCheckError` maps those onto "couldn't check right now"
 * instead of onto a claim about the key.
 *
 * A provider's own verdicts (a missing field, a wrong `institutionCode`, a
 * success envelope carrying a rejection code) return `{ valid: false }`
 * directly and never reach this.
 */
export function credentialRejection(err: unknown): { valid: false; message: string } {
  if (err instanceof ProviderError && err.kind === 'auth-failed') {
    return { valid: false, message: err.message };
  }
  throw err;
}
