import type { AppRouter } from '@scani/data-provider/types';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';

export type { AppRouter };

export interface CloudCallEvent {
  routes: string;
  status: number | 'error';
  durationMs: number;
  requestId?: string;
  error?: string;
}
export type CloudCallSink = (event: CloudCallEvent) => void;

export interface CloudClientOptions {
  url: string;
  apiKey: string;
  getRequestId?: () => string | undefined;
  // tRPC's `FetchEsque` and DOM's native `fetch` have slightly different
  // ReadableStream variance that makes exact typing fight the call site.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  fetch?: any;
  onCall?: CloudCallSink;
}

export type CloudClient = ReturnType<typeof createTRPCProxyClient<AppRouter>>;

export function createCloudClient(opts: CloudClientOptions): CloudClient {
  const baseUrl = opts.url.replace(/\/$/, '');
  const baseFetch =
    // biome-ignore lint/suspicious/noExplicitAny: matches CloudClientOptions.fetch
    (opts.fetch ?? globalThis.fetch) as (input: any, init?: any) => Promise<Response>;
  const instrumentedFetch = opts.onCall
    ? // biome-ignore lint/suspicious/noExplicitAny: matches CloudClientOptions.fetch
      async (input: any, init?: any) => {
        const start = Date.now();
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        const routes = extractRoutesFromUrl(url);
        try {
          const res = await baseFetch(input, init);
          // Sink errors must not poison the request path.
          try {
            opts.onCall?.({
              routes,
              status: res.status,
              durationMs: Date.now() - start,
              requestId: res.headers.get('x-request-id') ?? opts.getRequestId?.(),
            });
          } catch {}
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
          } catch {}
          throw err;
        }
      }
    : baseFetch;

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        // biome-ignore lint/suspicious/noExplicitAny: see CloudClientOptions.fetch
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

function extractRoutesFromUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://placeholder');
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? 'unknown';
    return decodeURIComponent(last);
  } catch {
    return 'unknown';
  }
}
