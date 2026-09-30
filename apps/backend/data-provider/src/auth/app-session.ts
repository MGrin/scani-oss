import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';

export type AppSessionResult =
  | { kind: 'user'; user: { id: string; email: string; name: string | null } }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string };

const MALFORMED = 'malformed get-session body';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Only Better-Auth's two documented answers are believed. Anything else — a
 * proxy's JSON error, a changed shape — is `unavailable`, never `none`: `none`
 * tells a signed-in user to sign in again, which cannot fix a broken reply.
 */
function readSessionBody(body: unknown): AppSessionResult {
  if (body === null) return { kind: 'none' };
  if (!isRecord(body)) return { kind: 'unavailable', reason: MALFORMED };
  const { user } = body;
  if (user === null || user === undefined) {
    return body.session === null ? { kind: 'none' } : { kind: 'unavailable', reason: MALFORMED };
  }
  if (
    !isRecord(user) ||
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    !(user.name === undefined || user.name === null || typeof user.name === 'string')
  ) {
    return { kind: 'unavailable', reason: MALFORMED };
  }
  return { kind: 'user', user: { id: user.id, email: user.email, name: user.name ?? null } };
}

/**
 * Asks the app's Better-Auth who a browser is, by forwarding its cookie to
 * `GET /api/auth/get-session`. The api is the only session issuer; the
 * console's cookie is the app's cookie.
 */
export class AppSessionClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;

  constructor(opts: { baseUrl: string; fetch?: typeof fetch; deadlineMs?: number }) {
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/api/auth/get-session`;
    this.fetchImpl = opts.fetch ?? fetch;
    this.deadlineMs = opts.deadlineMs ?? 3000;
  }

  async getSession(headers: Headers): Promise<AppSessionResult> {
    const cookie = headers.get('cookie');
    if (!cookie) return { kind: 'none' };

    let body: unknown;
    try {
      body = await withDeadline(
        this.fetchBody(cookie),
        this.deadlineMs,
        () => new StoreCommandTimeoutError('app', 'get-session', this.deadlineMs)
      );
    } catch (err) {
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    }
    return readSessionBody(body);
  }

  private async fetchBody(cookie: string): Promise<unknown> {
    // Only the cookie crosses: the caller's authorization, forwarding and
    // client-ip headers are claims about THIS request, not the app's.
    const res = await this.fetchImpl(this.endpoint, {
      headers: { cookie },
      signal: AbortSignal.timeout(this.deadlineMs),
    });
    if (!res.ok) throw new Error(`app get-session answered ${res.status}`);
    return res.json();
  }
}
