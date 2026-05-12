export interface PasskeyConfig {
  rpId: string;
  origin: string;
  credentialIdB64: string;
  publicKeyB64: string;
}

export function getPasskeyConfig(): PasskeyConfig {
  const rpId = process.env.ADMIN_RP_ID;
  const origin = process.env.ADMIN_ORIGIN;
  const credentialIdB64 = process.env.ADMIN_PASSKEY_CREDENTIAL_ID;
  const publicKeyB64 = process.env.ADMIN_PASSKEY_PUBLIC_KEY;

  if (!rpId) throw new Error('ADMIN_RP_ID missing');
  if (!origin) throw new Error('ADMIN_ORIGIN missing');
  if (!credentialIdB64) throw new Error('ADMIN_PASSKEY_CREDENTIAL_ID missing');
  if (!publicKeyB64) throw new Error('ADMIN_PASSKEY_PUBLIC_KEY missing');

  return { rpId, origin, credentialIdB64, publicKeyB64 };
}

export function getSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET missing or <32 chars');
  }
  return secret;
}

/**
 * Dev-only bypass for the passkey middleware. Hard-refuses to activate
 * when NODE_ENV=production so a leaked or copy-pasted env file can't
 * disable the admin gate in prod. If both flags are ever observed
 * together in prod we fail loud at boot rather than silently allowing
 * traffic — better a deploy outage than an open admin.
 */
export function devBypassEnabled(): boolean {
  const requested = process.env.ADMIN_DEV_BYPASS === '1';
  if (!requested) return false;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ADMIN_DEV_BYPASS=1 is set in a production environment. Refusing to start ' +
        'with passkey gating disabled. Unset ADMIN_DEV_BYPASS in the admin deployment.'
    );
  }
  return true;
}

/**
 * Bootstrap mode is active when no passkey has been provisioned yet AND a
 * one-time `ADMIN_BOOTSTRAP_TOKEN` is set. Middleware allows `/auth/bootstrap`
 * through so the operator can create the first passkey from the deployed app.
 * Once `ADMIN_PASSKEY_CREDENTIAL_ID` is set, bootstrap automatically locks.
 */
export function bootstrapStatus(): {
  enabled: boolean;
  tokenConfigured: boolean;
  passkeyProvisioned: boolean;
} {
  const passkeyProvisioned = Boolean(process.env.ADMIN_PASSKEY_CREDENTIAL_ID);
  const tokenConfigured = Boolean(process.env.ADMIN_BOOTSTRAP_TOKEN);
  return {
    enabled: tokenConfigured && !passkeyProvisioned,
    tokenConfigured,
    passkeyProvisioned,
  };
}

export function getRpIdAndOrigin(): { rpId: string; origin: string } {
  const rpId = process.env.ADMIN_RP_ID;
  const origin = process.env.ADMIN_ORIGIN;
  if (!rpId) throw new Error('ADMIN_RP_ID missing');
  if (!origin) throw new Error('ADMIN_ORIGIN missing');
  return { rpId, origin };
}
