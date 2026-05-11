'use server';

import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { cookies } from 'next/headers';
import { verifyPasskeyLogin } from '@/lib/auth/passkey';
import {
  SESSION_COOKIE,
  sessionCookieOpts,
  signSession,
  verifyChallenge,
} from '@/lib/auth/session';

export async function completeLoginAction(
  response: AuthenticationResponseJSON,
  challengeToken: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!challengeToken) return { ok: false, error: 'Missing challenge token' };

  const challenge = await verifyChallenge(challengeToken);
  if (!challenge) return { ok: false, error: 'Challenge expired or invalid' };

  let verified = false;
  try {
    verified = await verifyPasskeyLogin(response, challenge.challenge);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }

  if (!verified) return { ok: false, error: 'Passkey verification failed' };

  const session = await signSession();
  cookies().set(SESSION_COOKIE, session, sessionCookieOpts());
  return { ok: true };
}
