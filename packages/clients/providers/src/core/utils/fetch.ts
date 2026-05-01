/**
 * `fetchWithTimeout` — every provider's HTTP client of last resort.
 *
 * Adds three things on top of the global `fetch`:
 *
 *   1. **Timeout.** Default 8s; provider directories override per-
 *      endpoint when they know better (Etherscan, Finnhub).
 *   2. **Exponential-backoff retries** for 429/5xx/network errors.
 *   3. **URL pre-validation** so a typo in the provider's endpoint
 *      string fails synchronously instead of pretending to be a
 *      timeout.
 *
 * Ported verbatim from `packages/pricing-providers/src/utils.ts`. The
 * old `convertPrice` and `createFailureResult` helpers don't move
 * here — they're orchestrator concerns and stay in the domain layer.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_RETRIES = 2;

export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  maxRetries: number = DEFAULT_MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;

  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL format: ${url}. Check for typos in the URL or port number.`);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Request timeout after ${timeoutMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`
              )
            ),
          timeoutMs
        );
      });
      const fetchPromise = fetch(url, init);

      let response: Response;
      try {
        response = (await Promise.race([fetchPromise, timeoutPromise])) as Response;
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (attempt < maxRetries && shouldRetry(response)) {
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText} (attempt ${attempt + 1}/${maxRetries + 1})`
        );
        const backoffMs = 2 ** attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const enhancedError = new Error(
        `${lastError.message} - URL: ${url} (attempt ${attempt + 1}/${maxRetries + 1})`
      );
      enhancedError.name = lastError.name;
      enhancedError.stack = lastError.stack;
      lastError = enhancedError;

      if (attempt < maxRetries && isRetryableError(lastError)) {
        const backoffMs = 2 ** attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error(`Max retries (${maxRetries}) exceeded for URL: ${url}`);
}

function shouldRetry(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status >= 500 && response.status < 600) return true;
  return false;
}

function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  if (message.includes('timeout')) return true;
  if (message.includes('network')) return true;
  if (message.includes('econnreset')) return true;
  if (message.includes('enotfound')) return true;
  if (message.includes('connection')) return true;
  if (message.includes('unable to connect')) return true;
  if (message.includes('could not connect')) return true;
  if (message.includes('getaddrinfo')) return true;
  if (message.includes('etimedout')) return true;
  if (message.includes('socket')) return true;
  if (message.includes('econnrefused')) return true;
  return false;
}
