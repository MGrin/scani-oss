'use server';

import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { cookies } from 'next/headers';
import { verifyPasskeyLogin } from '@/lib/auth/passkey';
import {
  CHALLENGE_COOKIE,
  SESSION_COOKIE,
  sessionCookieOpts,
  signSession,
  verifyChallenge,
} from '@/lib/auth/session';

export async function completeLoginAction(
  response: AuthenticationResponseJSON
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cookieStore = cookies();
  const challengeToken = cookieStore.get(CHALLENGE_COOKIE)?.value;
  if (!challengeToken) return { ok: false, error: 'No challenge cookie' };

  const challenge = await verifyChallenge(challengeToken);
  if (!challenge) return { ok: false, error: 'Challenge expired or invalid' };

  cookieStore.delete(CHALLENGE_COOKIE);

  let verified = false;
  try {
    verified = await verifyPasskeyLogin(response, challenge.challenge);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }

  if (!verified) return { ok: false, error: 'Passkey verification failed' };

  const session = await signSession();
  cookieStore.set(SESSION_COOKIE, session, sessionCookieOpts());
  return { ok: true };
}
