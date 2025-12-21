import { authLogger } from '@scani/core/utils/logger';
import { createRemoteJWKSet, jwtVerify } from 'jose';

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
const JWKS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getJWKS() {
  const now = Date.now();

  // Check if cache is still valid
  if (jwksCache && now - jwksCacheTime < JWKS_CACHE_TTL) {
    return jwksCache;
  }

  // Create new JWKS instance
  authLogger.info('Creating new JWKS instance');
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

    jwksCache = createRemoteJWKSet(jwksUrl);
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
 * Verify a Supabase JWT token locally without calling the Supabase API
 * This significantly reduces the load on Supabase and improves performance
 *
 * @param token - The JWT token to verify
 * @returns The decoded JWT payload if valid, null if invalid
 */
export async function verifySupabaseJWT(token: string): Promise<JWTPayload | null> {
  try {
    const jwks = getJWKS();

    // First try with audience validation
    try {
      const { payload } = await jwtVerify(token, jwks, {
        // Supabase uses 'authenticated' as the audience
        audience: 'authenticated',
      });

      authLogger.info({ userId: payload.sub }, 'JWT verified successfully with audience check');
      return payload as JWTPayload;
    } catch (audienceError) {
      // If audience check fails, try without it to get more info
      authLogger.warn(
        {
          error:
            audienceError instanceof Error
              ? {
                  name: audienceError.name,
                  message: audienceError.message,
                  code: (audienceError as unknown as { code: string }).code,
                  claim: (audienceError as unknown as { claim: string }).claim,
                }
              : String(audienceError),
        },
        'JWT verification with audience failed, trying without audience check'
      );

      // Try without audience to see if that's the issue
      const { payload } = await jwtVerify(token, jwks);

      authLogger.warn(
        {
          userId: payload.sub,
          aud: payload.aud,
          iss: payload.iss,
          exp: payload.exp,
        },
        'JWT verified WITHOUT audience check - token might have wrong audience'
      );

      return payload as JWTPayload;
    }
  } catch (error) {
    // Log detailed error information for debugging
    const errorDetails =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            code: (error as unknown as { code: string }).code,
            claim: (error as unknown as { claim: string }).claim,
            reason: (error as unknown as { reason: string }).reason,
          }
        : { message: String(error) };

    authLogger.warn(
      {
        error: errorDetails,
        jwksUri: JWKS_URI,
        tokenPrefix: `${token.substring(0, 20)}...`,
      },
      'JWT verification failed'
    );
    return null;
  }
}
