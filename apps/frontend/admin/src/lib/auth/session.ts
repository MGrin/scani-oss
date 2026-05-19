import { b64urlDecode, b64urlEncode } from './b64';
import { getSessionSecret } from './config';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const SESSION_COOKIE = 'scani-admin-session';
export const CHALLENGE_COOKIE = 'scani-admin-challenge';

const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const CHALLENGE_TTL_SEC = 60 * 5;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(payload: object, ttlSec: number): Promise<string> {
  const sessionSecret = getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + ttlSec };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(full)));
  const key = await hmacKey(sessionSecret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

async function verify<T extends { exp: number }>(token: string): Promise<T | null> {
  const sessionSecret = getSessionSecret();
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  const key = await hmacKey(sessionSecret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(sigB64) as BufferSource,
    enc.encode(payloadB64)
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(payloadB64))) as T;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface SessionPayload {
  iat: number;
  exp: number;
}

export async function signSession(): Promise<string> {
  return sign({ t: 'session' }, SESSION_TTL_SEC);
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  return verify<SessionPayload & { t: string }>(token);
}

export interface ChallengePayload {
  challenge: string;
  iat: number;
  exp: number;
}

export async function signChallenge(challenge: string): Promise<string> {
  return sign({ t: 'challenge', challenge }, CHALLENGE_TTL_SEC);
}

export async function verifyChallenge(token: string): Promise<ChallengePayload | null> {
  return verify<ChallengePayload & { t: string }>(token);
}

export function sessionCookieOpts(maxAgeSec = SESSION_TTL_SEC) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // 'strict' rather than 'lax': the admin console is single-tenant,
    // passkey-gated, and never reached via a cross-site link, so the
    // cookie should never ride a cross-site request.
    sameSite: 'strict' as const,
    path: '/',
    maxAge: maxAgeSec,
  };
}

export function challengeCookieOpts() {
  return sessionCookieOpts(CHALLENGE_TTL_SEC);
}
