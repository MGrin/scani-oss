import type { AppRouter } from '@scani/data-provider/types';
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from '@trpc/client';

/**
 * Per-call instrumentation hook. Backend wires this to
 * `Sentry.addBreadcrumb` so any error captured downstream carries the
 * cloud-hop trail (route, status, duration). Frontend / tests can leave
 * it unset and the link becomes a no-op.
 */
export interface CloudCallEvent {
  /** tRPC route(s) the batch covered, joined with ",". */
  routes: string;
  /** HTTP status from the data-provider — `'error'` if the fetch threw. */
  status: number | 'error';
  durationMs: number;
  requestId?: string;
  error?: string;
}
export type CloudCallSink = (event: CloudCallEvent) => void;

/**
 * `@scani/cloud-client`
 *
 * Typed client for the Scani data-provider service. Backend and worker use
 * this to call out to `api.cloud.scani.xyz` (managed tiers) or a
 * self-hosted data-provider (OSS tier).
 *
 * Domain-facing adapters (CloudPricingProvider, CloudChainService, ...) are
 * exported as sub-paths and implement the exact same interfaces as today's
 * direct packages, so the call sites inside `@scani/domain` don't change.
 */

export type { AppRouter };

export interface CloudClientOptions {
  /**
   * Base URL of the data-provider HTTP service, no trailing slash:
   *   - Tier 1 OSS:      http://data-provider:8082
   *   - Tier 2 semi-mgd: https://api.cloud.scani.xyz
   *   - Tier 3 SaaS:     https://api.cloud.scani.xyz
   */
  url: string;
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /**
   * Optional callback that lets callers stamp each outgoing request with
   * the current request id for distributed tracing. Cheaper than a full
   * AsyncLocalStorage dance and good enough since every caller on the hot
   * path already threads a `requestId` through DI.
   */
  getRequestId?: () => string | undefined;
  /**
   * Fetch implementation override — defaults to `globalThis.fetch`. Tests
   * swap this for a mock; production may inject a keep-alive-pooled
   * variant once latency numbers justify it. Typed loosely (any) because
   * trpc's `FetchEsque` and DOM's native `fetch` have slightly different
   * ReadableStream variance that makes exact typing fight the shape we
   * actually need at the call site.
   */
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  fetch?: any;
  /**
   * Optional sink called once per HTTP batch. Used for Sentry breadcrumbs
   * + lightweight latency telemetry — when unset the link is a no-op.
   * Must not throw; cloud-client swallows callback errors so a misbehaving
   * sink can't break a real request.
   */
  onCall?: CloudCallSink;
}

export type CloudClient = ReturnType<typeof createTRPCProxyClient<AppRouter>>;

export function createCloudClient(opts: CloudClientOptions): CloudClient {
  const baseUrl = opts.url.replace(/\/$/, '');
  // When onCall is wired up, instrument the fetch so each HTTP batch gets
  // a breadcrumb-ready event. Wrapping fetch (rather than writing a
  // bespoke tRPC link) keeps the batch+abort+streaming behavior of
  // httpBatchLink intact.
  const baseFetch =
    // biome-ignore lint/suspicious/noExplicitAny: matches the loose `fetch?: any` option type
    (opts.fetch ?? globalThis.fetch) as (input: any, init?: any) => Promise<Response>;
  const instrumentedFetch = opts.onCall
    ? // biome-ignore lint/suspicious/noExplicitAny: matches the loose `fetch?: any` option type
      async (input: any, init?: any) => {
        const start = Date.now();
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        const routes = extractRoutesFromUrl(url);
        try {
          const res = await baseFetch(input, init);
          try {
            opts.onCall?.({
              routes,
              status: res.status,
              durationMs: Date.now() - start,
              requestId: res.headers.get('x-request-id') ?? opts.getRequestId?.(),
            });
          } catch {
            // Breadcrumb failures must not poison the request path.
          }
          return res;
        } catch (err) {
          try {
            opts.onCall?.({
              routes,
              status: 'error',
              durationMs: Date.now() - start,
              requestId: opts.getRequestId?.(),
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {
            // see above
          }
          throw err;
        }
      }
    : baseFetch;

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        // Cast to any: same FetchEsque vs DOM-fetch ReadableStream
        // variance dance the `fetch?: any` option type already documents.
        // biome-ignore lint/suspicious/noExplicitAny: see CloudClientOptions.fetch comment
        fetch: instrumentedFetch as any,
        headers() {
          const headers: Record<string, string> = {
            authorization: `Bearer ${opts.apiKey}`,
          };
          const rid = opts.getRequestId?.();
          if (rid) headers['x-request-id'] = rid;
          return headers;
        },
      }),
    ],
  });
}

/**
 * Pull tRPC paths out of an httpBatchLink URL — they appear as the
 * pathname's last segment, comma-separated when batched. Returns
 * 'unknown' if the URL doesn't parse, since a breadcrumb without a
 * route is still better than a silent breadcrumb failure.
 */
function extractRoutesFromUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://placeholder');
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? 'unknown';
    return decodeURIComponent(last);
  } catch {
    return 'unknown';
  }
}

/**
 * Typed error thrown by domain adapters. Wraps the underlying tRPC error
 * so call sites can pattern-match on `code` without importing tRPC
 * directly. `cause` preserves the original for logging.
 */
export class CloudError extends Error {
  readonly code: string;
  // biome-ignore lint/suspicious/noExplicitAny: cause is intentionally any
  override readonly cause: any;
  readonly retryable: boolean;

  // biome-ignore lint/suspicious/noExplicitAny: cause is intentionally any
  constructor(message: string, code: string, cause: any, retryable = false) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.cause = cause;
    this.retryable = retryable;
  }

  static wrap(err: unknown, fallback = 'INTERNAL_SERVER_ERROR'): CloudError {
    if (err instanceof CloudError) return err;
    if (err instanceof TRPCClientError) {
      const code = (err.data as { code?: string } | null | undefined)?.code ?? fallback;
      const retryable =
        code === 'TIMEOUT' || code === 'TOO_MANY_REQUESTS' || code === 'INTERNAL_SERVER_ERROR';
      return new CloudError(err.message, code, err, retryable);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new CloudError(message, fallback, err, true);
  }
}
