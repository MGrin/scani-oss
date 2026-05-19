'use server';

import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { cookies, headers } from 'next/headers';
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
  if (!expected || expected.length < 32) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(providedToken);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

/**
 * In-memory lock flipped on after a successful `completeBootstrapAction`.
 *
 * Closes the window between "passkey just provisioned" and "operator sets
 * `ADMIN_PASSKEY_CREDENTIAL_ID` + `ADMIN_PASSKEY_PUBLIC_KEY` env vars +
 * redeploys". During that interval `bootstrapStatus().passkeyProvisioned`
 * reads as `false` (env var not yet set), so without this flag a second
 * call with the same token could re-register a different passkey.
 *
 * The lock is per-process: a deploy restart wipes it, which is fine
 * because the env-based check takes over once the operator rotates.
 */
let provisionedInThisProcess = false;

function checkBootstrap(token: string): string | null {
  if (provisionedInThisProcess) {
    console.warn('[admin][bootstrap] attempt after in-process provision — denied');
    return 'Passkey already provisioned in this process. Rotate ADMIN_BOOTSTRAP_TOKEN and redeploy.';
  }
  const status = bootstrapStatus();
  if (status.passkeyProvisioned) {
    // Loud audit trail — anyone hitting this endpoint after provision is
    // either re-deploying with stale env or attempting a passkey swap.
    // Log the attempt so dashboards can alert on spikes.
    console.warn('[admin][bootstrap] attempt while passkey already provisioned — denied');
    return 'Passkey already provisioned. Bootstrap is locked.';
  }
  if (!status.tokenConfigured) return 'Bootstrap is not enabled.';
  if (!authorized(token)) {
    console.warn('[admin][bootstrap] invalid bootstrap token — denied');
    return 'Invalid bootstrap token.';
  }
  return null;
}

// Per-process, per-IP throttle on bootstrap attempts. The token is already
// length-gated + timing-safe-compared, so this is defence-in-depth against a
// weak token: it caps online guessing. Per-process is acceptable — bootstrap
// is a one-shot operation on a single-tenant admin (same rationale as
// `provisionedInThisProcess`).
const BOOTSTRAP_MAX_ATTEMPTS = 6;
const BOOTSTRAP_WINDOW_MS = 60_000;
const bootstrapAttempts = new Map<string, number[]>();

function bootstrapRateLimited(): boolean {
  const h = headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  const now = Date.now();
  const recent = (bootstrapAttempts.get(ip) ?? []).filter((t) => now - t < BOOTSTRAP_WINDOW_MS);
  recent.push(now);
  bootstrapAttempts.set(ip, recent);
  return recent.length > BOOTSTRAP_MAX_ATTEMPTS;
}

export type BeginResult =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; error: string };

export async function beginBootstrapAction(token: string): Promise<BeginResult> {
  try {
    if (bootstrapRateLimited()) {
      console.warn('[admin][bootstrap] rate limit exceeded — denied');
      return { ok: false, error: 'Too many attempts. Wait a minute and try again.' };
    }
    const err = checkBootstrap(token);
    if (err) return { ok: false, error: err };

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
    return { ok: true, options };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function completeBootstrapAction(
  token: string,
  response: RegistrationResponseJSON
): Promise<
  | {
      ok: true;
      credentialId: string;
      publicKey: string;
    }
  | { ok: false; error: string }
> {
  try {
    const err = checkBootstrap(token);
    if (err) return { ok: false, error: err };

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
    // Flip the in-process lock before we return, so any subsequent call
    // with the (still-valid) ADMIN_BOOTSTRAP_TOKEN is rejected even if
    // the operator hasn't yet set the env vars + redeployed. Closes the
    // "window between provision and lockdown" gap.
    provisionedInThisProcess = true;
    // Loud log at successful provision so operators can confirm the
    // one-shot happened and know to invalidate `ADMIN_BOOTSTRAP_TOKEN`.
    // Dashboards should page on any subsequent `admin][bootstrap` log line
    // after this event — it means someone's trying to re-provision.
    console.warn(
      '[admin][bootstrap] 🔐 passkey provisioned — set ADMIN_PASSKEY_CREDENTIAL_ID / ADMIN_PASSKEY_PUBLIC_KEY env vars and ROTATE ADMIN_BOOTSTRAP_TOKEN immediately'
    );
    return {
      ok: true,
      credentialId: info.credential.id,
      publicKey: b64urlEncode(info.credential.publicKey),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
