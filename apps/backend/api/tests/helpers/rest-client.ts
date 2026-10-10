import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import type { AgentDeps } from '../../src/agent-access/pipeline';
import { createRestDeps, handleRestRequest } from '../../src/rest/handler';
import { suffix } from './agent-tenant';
import { roomyHeavyLimiter } from './limiters';

export function restDeps(overrides: Partial<Parameters<typeof createRestDeps>[0]> = {}): AgentDeps {
  return createRestDeps({
    accessAllowed: async () => true,
    heavyLimiter: roomyHeavyLimiter(),
    limiter: new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 10_000,
      namespace: `rl:test-rest-${suffix}`,
    }),
    ...overrides,
  });
}

export interface RestAnswer {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whichever fields its route answers with
  body: any;
}

/** One request through the REST handler, as Elysia hands it over. */
export async function rest(
  token: string | null,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    deps?: AgentDeps;
  } = {}
): Promise<RestAnswer> {
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await handleRestRequest(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...opts.headers,
      },
      body,
    }),
    opts.deps ?? restDeps()
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
