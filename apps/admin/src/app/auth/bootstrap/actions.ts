'use server';

import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { cookies } from 'next/headers';
import { b64urlEncode } from '@/lib/auth/b64';
import { bootstrapStatus, getRpIdAndOrigin } from '@/lib/auth/config';
import {
  CHALLENGE_COOKIE,
  challengeCookieOpts,
  signChallenge,
  verifyChallenge,
} from '@/lib/auth/session';

function authorized(providedToken: string): boolean {
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!expected || expected.length < 16) return false;
  // Timing-safe compare against a same-length buffer to avoid early-exit leaks.
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(providedToken);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

function ensureBootstrapEnabled(token: string) {
  const status = bootstrapStatus();
  if (status.passkeyProvisioned)
    throw new Error('Passkey already provisioned. Bootstrap is locked.');
  if (!status.tokenConfigured) throw new Error('Bootstrap is not enabled.');
  if (!authorized(token)) throw new Error('Invalid bootstrap token.');
}

export async function beginBootstrapAction(
  token: string
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  ensureBootstrapEnabled(token);
  const { rpId } = getRpIdAndOrigin();

  const userId = crypto.getRandomValues(new Uint8Array(16));
  const options = await generateRegistrationOptions({
    rpName: 'scani admin',
    rpID: rpId,
    userID: userId,
    userName: 'admin',
    attestationType: 'none',
    authenticatorSelection: {
      userVerification: 'preferred',
      residentKey: 'preferred',
    },
  });

  const challengeToken = await signChallenge(options.challenge);
  cookies().set(CHALLENGE_COOKIE, challengeToken, challengeCookieOpts());
  return options;
}

export async function completeBootstrapAction(
  token: string,
  response: RegistrationResponseJSON
): Promise<
  | {
      ok: true;
      credentialId: string;
      publicKey: string;
      sessionSecret: string;
    }
  | { ok: false; error: string }
> {
  try {
    ensureBootstrapEnabled(token);

    const challengeToken = cookies().get(CHALLENGE_COOKIE)?.value;
    if (!challengeToken) return { ok: false, error: 'No challenge in progress.' };
    const challenge = await verifyChallenge(challengeToken);
    if (!challenge) return { ok: false, error: 'Challenge expired.' };
    cookies().delete(CHALLENGE_COOKIE);

    const { rpId, origin } = getRpIdAndOrigin();
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, error: 'Passkey verification failed.' };
    }

    const info = verification.registrationInfo;
    return {
      ok: true,
      credentialId: info.credential.id,
      publicKey: b64urlEncode(info.credential.publicKey),
      sessionSecret: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
