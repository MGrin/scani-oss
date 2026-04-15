import { authLogger } from '@scani/core/utils/logger';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// SUPABASE_URL is validated at startup by config/env.ts; this assertion is a
// safety net for test setups that import this module without booting the app.
const SUPABASE_URL = process.env.SUPABASE_URL;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL environment variable is required');
}

// Remove trailing slash from SUPABASE_URL if present
const supabaseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;

// JWKS endpoint for the Supabase project
const JWKS_URI = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;

// Cache for JWKS - jose's createRemoteJWKSet handles caching internally with a default TTL
// We'll create a new JWKS instance that will be reused
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 60 minutes (reduced refresh frequency to prevent performance issues)

// Timeout constants for JWT operations
const JWKS_FETCH_TIMEOUT_MS = 10000; // 10 seconds
const JWKS_COOLDOWN_MS = 30000; // 30 seconds
const JWT_VERIFICATION_TIMEOUT_MS = 10000; // 10 seconds

function getJWKS() {
  const now = Date.now();

  // Check if cache is still valid
  if (jwksCache && now - jwksCacheTime < JWKS_CACHE_TTL) {
    return jwksCache;
  }

  // Create new JWKS instance
  authLogger.info('Creating new JWKS instance or refreshing cache');
  try {
    const jwksUrl = new URL(JWKS_URI);
    authLogger.info(
      {
        jwksUri: JWKS_URI,
        protocol: jwksUrl.protocol,
        host: jwksUrl.host,
        pathname: jwksUrl.pathname,
      },
      'JWKS URL parsed successfully'
    );

    jwksCache = createRemoteJWKSet(jwksUrl, {
      // Add timeout options to prevent hanging
      timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
    });
    jwksCacheTime = now;
    authLogger.info('New JWKS instance created');
    return jwksCache;
  } catch (error) {
    authLogger.error(
      {
        error:
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
        jwksUri: JWKS_URI,
        supabaseUrl: supabaseUrl,
      },
      'Failed to create JWKS instance'
    );

    // If we have a stale cache, use it as fallback
    if (jwksCache) {
      authLogger.warn('Using stale JWKS cache as fallback');
      return jwksCache;
    }

    throw error;
  }
}

export interface JWTPayload {
  sub: string; // User ID
  email?: string;
  aud?: string;
  role?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

/**
 * Thrown when JWT verification cannot reach a conclusive answer because of
 * infrastructure problems (JWKS endpoint unreachable, timeout, etc).
 *
 * Callers must map this to HTTP 503, NOT 401 — the token may be perfectly
 * valid, we just couldn't verify it. Logging every user out during a slow
 * JWKS fetch is a much worse outcome than a short outage.
 */
export class JwksUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'JwksUnavailableError';
  }
}

// jose error codes that indicate the token is definitively invalid. Anything
// else (network errors, our own timeout) is treated as infrastructure failure.
const DEFINITIVE_JOSE_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWK_INVALID',
]);

function isDefinitivelyInvalidToken(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code && DEFINITIVE_JOSE_CODES.has(code)) return true;
  // jose's JWTExpired, JWTClaimValidationFailed, etc. set .name too
  return (
    error.name === 'JWTExpired' ||
    error.name === 'JWTClaimValidationFailed' ||
    error.name === 'JWTInvalid' ||
    error.name === 'JWSInvalid' ||
    error.name === 'JWSSignatureVerificationFailed'
  );
}

async function verifyWithTimeout(token: string, attempt: number): Promise<JWTPayload> {
  const jwks = getJWKS();

  const verificationPromise = jwtVerify(token, jwks, {
    audience: 'authenticated',
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new JwksUnavailableError(`JWT verification timeout (attempt ${attempt})`)),
      JWT_VERIFICATION_TIMEOUT_MS
    );
  });

  try {
    const { payload } = await Promise.race([verificationPromise, timeoutPromise]);
    return payload as JWTPayload;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Verify a Supabase JWT token locally without calling the Supabase API.
 *
 * Distinguishes two failure modes:
 *   - Token is definitively invalid/expired → returns `null` (→ HTTP 401)
 *   - JWKS fetch failed / timed out       → throws `JwksUnavailableError` (→ HTTP 503)
 *
 * Retries infrastructure failures once with a short backoff before giving up.
 */
export async function verifySupabaseJWT(token: string): Promise<JWTPayload | null> {
  const maxAttempts = 2;
  let lastInfraError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const payload = await verifyWithTimeout(token, attempt);
      authLogger.info(
        {
          userId: payload.sub,
          email: payload.email,
          aud: payload.aud,
        },
        'JWT verified successfully'
      );
      return payload;
    } catch (error) {
      if (isDefinitivelyInvalidToken(error)) {
        const errorDetails =
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                code: (error as { code?: string }).code,
              }
            : { message: String(error) };
        authLogger.warn(
          {
            error: errorDetails,
            tokenPrefix: `${token.substring(0, 20)}...`,
          },
          'JWT is invalid'
        );
        return null;
      }

      lastInfraError = error;
      authLogger.warn(
        {
          attempt,
          maxAttempts,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
          jwksUri: JWKS_URI,
        },
        'JWT verification failed with infrastructure error — will retry if attempts remain'
      );

      if (attempt < maxAttempts) {
        // Short backoff so we don't hammer a failing JWKS endpoint.
        await new Promise((r) => setTimeout(r, 250 * attempt));
        // Drop cached JWKS so the next attempt rebuilds it.
        jwksCache = null;
        jwksCacheTime = 0;
      }
    }
  }

  throw new JwksUnavailableError(
    'JWT verification failed: JWKS endpoint unavailable after retries',
    lastInfraError
  );
}
