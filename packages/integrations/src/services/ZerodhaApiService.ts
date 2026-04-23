/**
 * ZerodhaApiService
 *
 * Zerodha Kite Connect authenticated API.
 * - GET /portfolio/holdings → list of equity holdings
 * - Auth: `Authorization: token <api_key>:<access_token>`
 * - access_token rotates daily (invalidated around 06:00 IST); we
 *   refresh it ourselves from the user's Kite credentials + TOTP secret
 *   so reads keep working without daily manual re-auth.
 *
 * Docs: https://kite.trade/docs/connect/v3/
 */

import crypto from 'node:crypto';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

export interface ZerodhaHolding {
  tradingsymbol: string;
  exchange: string;
  instrument_token: number;
  isin?: string;
  quantity: number;
  t1_quantity?: number;
  realised_quantity?: number;
  average_price?: number;
  last_price?: number;
  close_price?: number;
  pnl?: number;
  day_change?: number;
  day_change_percentage?: number;
  product?: string;
}

export interface ZerodhaUserMargins {
  equity?: {
    enabled: boolean;
    net: number;
    available?: { cash?: number };
  };
  commodity?: unknown;
}

interface ZerodhaEnvelope<T> {
  status: string;
  data?: T;
  message?: string;
  error_type?: string;
}

/**
 * RFC 6238 TOTP generator. Zerodha's 2FA uses standard 6-digit TOTP
 * with 30s period, SHA-1. Implementing inline rather than pulling a
 * dep to keep the integrations package lean.
 */
function generateTotpCode(base32Secret: string): string {
  const secretBytes = base32Decode(base32Secret.replace(/=+$/, '').toUpperCase());
  const counter = Math.floor(Date.now() / 30000);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const code =
    (((hmac.at(offset) ?? 0) & 0x7f) << 24) |
    (((hmac.at(offset + 1) ?? 0) & 0xff) << 16) |
    (((hmac.at(offset + 2) ?? 0) & 0xff) << 8) |
    ((hmac.at(offset + 3) ?? 0) & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const ch of input) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export interface ZerodhaLoginCredentials {
  apiKey: string;
  apiSecret: string;
  userId: string;
  password: string;
  totpSecret: string;
}

/** Kite access_tokens expire around 06:00 IST. We cache for 20h to
 * leave a comfortable margin, and still invalidate immediately on any
 * 403 from read endpoints. */
const TOKEN_CACHE_TTL_MS = 20 * 60 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class ZerodhaApiService {
  private readonly baseUrl: string;
  private readonly kiteLoginBaseUrl: string;
  private readonly rateLimiter?: RateLimiter;
  private readonly tokenCache = new Map<string, CachedToken>();

  constructor(baseUrl: string, rateLimiter?: RateLimiter, kiteLoginBaseUrl?: string) {
    this.baseUrl = baseUrl;
    this.rateLimiter = rateLimiter;
    this.kiteLoginBaseUrl =
      kiteLoginBaseUrl || process.env.ZERODHA_KITE_LOGIN_URL || 'https://kite.zerodha.com';
  }

  /** Build a stable cache key that changes whenever any login-impacting
   * field changes (so password or TOTP-secret rotation invalidates the
   * cache immediately). */
  private tokenCacheKey(creds: ZerodhaLoginCredentials): string {
    return crypto
      .createHash('sha256')
      .update(`${creds.apiKey}:${creds.userId}:${creds.password}:${creds.totpSecret}`)
      .digest('hex');
  }

  /** Returns a cached + still-valid access_token for these credentials,
   * or mints a new one. Callers can force a fresh mint (e.g. after a
   * 403) by passing `forceRefresh = true`. */
  async getOrRefreshAccessToken(
    creds: ZerodhaLoginCredentials,
    forceRefresh = false
  ): Promise<string> {
    const key = this.tokenCacheKey(creds);
    const cached = this.tokenCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }
    const fresh = await this.refreshAccessToken(creds);
    this.tokenCache.set(key, {
      accessToken: fresh,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    });
    return fresh;
  }

  /** Drop the cached token for these creds (e.g. after a 403). */
  invalidateToken(creds: ZerodhaLoginCredentials): void {
    this.tokenCache.delete(this.tokenCacheKey(creds));
  }

  private async authedGet<T>(path: string, apiKey: string, accessToken: string): Promise<T> {
    const subKey = credentialBucketKey(`${apiKey}:${accessToken}`);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `token ${apiKey}:${accessToken}`,
            'X-Kite-Version': '3',
            Accept: 'application/json',
          },
        }),
      subKey
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Zerodha HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const envelope = (await response.json()) as ZerodhaEnvelope<T>;
    if (envelope.status !== 'success') {
      throw new Error(`Zerodha: ${envelope.message ?? 'unknown error'}`);
    }
    return envelope.data as T;
  }

  async validateCredentials(apiKey: string, accessToken: string): Promise<boolean> {
    const subKey = credentialBucketKey(`${apiKey}:${accessToken}`);
    const response = await this.executeWithRateLimit(
      () =>
        fetch(`${this.baseUrl}/user/profile`, {
          method: 'GET',
          headers: {
            Authorization: `token ${apiKey}:${accessToken}`,
            'X-Kite-Version': '3',
          },
        }),
      subKey
    );
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Zerodha HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  }

  async getHoldings(apiKey: string, accessToken: string): Promise<ZerodhaHolding[]> {
    return this.authedGet<ZerodhaHolding[]>('/portfolio/holdings', apiKey, accessToken);
  }

  async getMargins(apiKey: string, accessToken: string): Promise<ZerodhaUserMargins> {
    return this.authedGet<ZerodhaUserMargins>('/user/margins', apiKey, accessToken);
  }

  /**
   * Run the full Kite login → TOTP → session/token flow to produce a
   * fresh access_token. Requires the user's Kite client ID, password,
   * and their TOTP (Authenticator) secret — none of which are part of
   * the Kite Connect developer-side app config.
   *
   * This sequence uses unofficial endpoints (`/api/login`, `/api/twofa`)
   * that the Kite web/app uses. Zerodha hasn't deprecated them for
   * individual-account use but they can change without notice; if that
   * happens, we fall back to surfacing a `reauth_required` status and
   * the user can re-enter creds.
   */
  async refreshAccessToken(creds: ZerodhaLoginCredentials): Promise<string> {
    const subKey = credentialBucketKey(`${creds.apiKey}:${creds.userId}`);
    return this.executeWithRateLimit(async () => {
      const cookies: Record<string, string> = {};
      const absorbCookies = (headers: Response['headers']) => {
        const setCookie = headers.get('set-cookie');
        if (!setCookie) return;
        // Node's fetch flattens multiple Set-Cookie headers with a
        // comma; split carefully because cookie Expires values also
        // contain commas. A forgiving split on `, <name>=` is fine for
        // Kite's cookies (no complex attributes).
        for (const entry of setCookie.split(/,(?=\s*[a-zA-Z0-9_-]+=)/)) {
          const nameValue = entry.split(';')[0] ?? '';
          const eq = nameValue.indexOf('=');
          if (eq <= 0) continue;
          const name = nameValue.slice(0, eq).trim();
          const value = nameValue.slice(eq + 1).trim();
          cookies[name] = value;
        }
      };
      const cookieHeader = () =>
        Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

      // Step 1 — userid + password → request_id.
      const loginRes = await fetch(`${this.kiteLoginBaseUrl}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Kite-Version': '3',
        },
        body: new URLSearchParams({
          user_id: creds.userId,
          password: creds.password,
        }).toString(),
        redirect: 'manual',
      });
      absorbCookies(loginRes.headers);
      if (!loginRes.ok) {
        const text = await loginRes.text().catch(() => '');
        throw new Error(
          `Zerodha login HTTP ${loginRes.status}${text ? `: ${text.slice(0, 200)}` : ''}`
        );
      }
      const loginJson = (await loginRes.json()) as ZerodhaEnvelope<{ request_id: string }>;
      if (loginJson.status !== 'success' || !loginJson.data?.request_id) {
        throw new Error(`Zerodha login failed: ${loginJson.message ?? 'no request_id'}`);
      }
      const requestId = loginJson.data.request_id;

      // Step 2 — request_id + TOTP → enctoken cookie.
      const totpCode = generateTotpCode(creds.totpSecret);
      const twofaRes = await fetch(`${this.kiteLoginBaseUrl}/api/twofa`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Kite-Version': '3',
          Cookie: cookieHeader(),
        },
        body: new URLSearchParams({
          user_id: creds.userId,
          request_id: requestId,
          twofa_value: totpCode,
          twofa_type: 'totp',
        }).toString(),
        redirect: 'manual',
      });
      absorbCookies(twofaRes.headers);
      if (!twofaRes.ok) {
        const text = await twofaRes.text().catch(() => '');
        throw new Error(
          `Zerodha 2FA HTTP ${twofaRes.status}${text ? `: ${text.slice(0, 200)}` : ''}`
        );
      }

      // Step 3 — OAuth redirect chain → request_token.
      // Kite redirects from /connect/login → user login check (200 with
      // the auth cookies already set) → finish endpoint → back to our
      // redirect_uri with `?request_token=`. We stop as soon as we see
      // the token in any redirect Location.
      let requestToken: string | null = null;
      let nextUrl: string | null =
        `${this.kiteLoginBaseUrl}/connect/login?v=3&api_key=${encodeURIComponent(creds.apiKey)}`;
      for (let hops = 0; hops < 8 && nextUrl && !requestToken; hops += 1) {
        const res: Response = await fetch(nextUrl, {
          method: 'GET',
          headers: { Cookie: cookieHeader() },
          redirect: 'manual',
        });
        absorbCookies(res.headers);
        const loc = res.headers.get('location');
        if (loc) {
          const resolved: URL = new URL(loc, nextUrl);
          const tokenParam = resolved.searchParams.get('request_token');
          if (tokenParam) {
            requestToken = tokenParam;
            break;
          }
          nextUrl = resolved.toString();
          continue;
        }
        // No redirect: either we landed somewhere the API surfaced an
        // error page, or we're stuck. Bail rather than loop.
        const body = await res.text().catch(() => '');
        throw new Error(
          `Zerodha OAuth redirect did not produce request_token (HTTP ${res.status})${body ? `: ${body.slice(0, 120)}` : ''}`
        );
      }
      if (!requestToken) {
        throw new Error('Zerodha OAuth redirect produced no request_token after 8 hops');
      }

      // Step 4 — request_token + checksum → access_token.
      const checksum = crypto
        .createHash('sha256')
        .update(`${creds.apiKey}${requestToken}${creds.apiSecret}`)
        .digest('hex');

      const tokenRes = await fetch(`${this.baseUrl}/session/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Kite-Version': '3',
        },
        body: new URLSearchParams({
          api_key: creds.apiKey,
          request_token: requestToken,
          checksum,
        }).toString(),
      });
      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        throw new Error(
          `Zerodha session/token HTTP ${tokenRes.status}${text ? `: ${text.slice(0, 200)}` : ''}`
        );
      }
      const tokenJson = (await tokenRes.json()) as ZerodhaEnvelope<{ access_token: string }>;
      if (tokenJson.status !== 'success' || !tokenJson.data?.access_token) {
        throw new Error(`Zerodha session/token failed: ${tokenJson.message ?? 'no access_token'}`);
      }
      return tokenJson.data.access_token;
    }, subKey);
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }
}

// Exported for tests only.
export const __test_generateTotpCode = generateTotpCode;
