import { authLogger } from '@scani/core/utils/logger';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const SUPABASE_URL = process.env.SUPABASE_URL;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL environment variable is required');
}

// Remove trailing slash from SUPABASE_URL if present
const supabaseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;

// JWKS endpoint for the Supabase project
const JWKS_URI = `${supabaseUrl}/auth/v1/jwks.json`;

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
  authLogger.debug({ jwksUri: JWKS_URI }, 'Creating new JWKS instance');
  jwksCache = createRemoteJWKSet(new URL(JWKS_URI));
  jwksCacheTime = now;

  return jwksCache;
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

    // Verify the JWT signature and decode the payload
    const { payload } = await jwtVerify(token, jwks, {
      // Supabase uses 'authenticated' as the audience
      audience: 'authenticated',
    });

    authLogger.debug({ userId: payload.sub }, 'JWT verified successfully');

    return payload as JWTPayload;
  } catch (error) {
    authLogger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'JWT verification failed'
    );
    return null;
  }
}
