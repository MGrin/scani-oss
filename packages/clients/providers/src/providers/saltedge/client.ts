import { createSign } from 'node:crypto';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../core/errors';

const INSTITUTION_CODE = 'saltedge';
const DEFAULT_BASE_URL = 'https://www.saltedge.com';
/** Salt Edge accepts an `Expires-at` at most one hour ahead; well inside it. */
const SIGNATURE_TTL_SECONDS = 3000;

export interface SaltEdgeCredentials {
  appId: string;
  secret: string;
  /**
   * PEM private key whose public half is uploaded to the Salt Edge dashboard.
   * Signing is optional in Pending and Test and mandatory once Live, so it is
   * used whenever present rather than switched on by status.
   */
  privateKeyPem?: string;
}

interface SaltEdgeClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Page<T> {
  data: T[];
  meta?: { next_id?: string | null };
}

/** The string Salt Edge verifies a request signature over. */
export function signatureBase(
  expiresAt: string,
  method: string,
  url: string,
  body: string
): string {
  return `${expiresAt}|${method}|${url}|${body}`;
}

/**
 * Salt Edge API v6: `App-id` and `Secret` on every request, an RSA-SHA256
 * `Signature` when a private key is configured, and cursor paging through
 * `meta.next_id` → `from_id`.
 */
export class SaltEdgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly creds: SaltEdgeCredentials,
    private readonly limiter: OutflowRateLimiter,
    opts: SaltEdgeClientOptions = {}
  ) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Every item of a list endpoint, across all its pages. */
  async list<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let fromId: string | null = null;
    do {
      const query = new URLSearchParams(params);
      if (fromId) query.set('from_id', fromId);
      const page: Page<T> = await this.get<Page<T>>(`${path}?${query.toString()}`);
      out.push(...(page.data ?? []));
      fromId = page.meta?.next_id ?? null;
    } while (fromId);
    return out;
  }

  async post<T>(path: string, data: unknown): Promise<T> {
    const reply = await this.send<{ data: T }>('POST', path, JSON.stringify({ data }));
    return reply.data;
  }

  private get<T>(pathAndQuery: string): Promise<T> {
    return this.send<T>('GET', pathAndQuery, '');
  }

  private async send<T>(method: 'GET' | 'POST', pathAndQuery: string, body: string): Promise<T> {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'App-id': this.creds.appId,
      Secret: this.creds.secret,
    };
    if (this.creds.privateKeyPem) {
      const expiresAt = String(Math.floor(this.now() / 1000) + SIGNATURE_TTL_SECONDS);
      const signer = createSign('RSA-SHA256');
      signer.update(signatureBase(expiresAt, method, url, body));
      headers['Expires-at'] = expiresAt;
      headers.Signature = signer.sign(this.creds.privateKeyPem, 'base64');
    }
    const response = await this.limiter.execute(() =>
      this.fetchImpl(url, { method, headers, body: method === 'POST' ? body : undefined })
    );
    if (!response.ok) throw ProviderError.fromHttp(INSTITUTION_CODE, response);
    return (await response.json()) as T;
  }
}
