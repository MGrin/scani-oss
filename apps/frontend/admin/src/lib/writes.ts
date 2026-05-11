import { getEnv } from './env';

/**
 * Master switch for every admin write action. Defaults OFF in production
 * so a half-deployed backend (or a missing HMAC secret) can't accept
 * mutations; the operator flips it explicitly in Cloudflare Pages env
 * once the backend half is in place.
 *
 * - `ADMIN_WRITES_ENABLED=1` → writes enabled
 * - `ADMIN_WRITES_ENABLED=0` (or unset) → writes return 503 + buttons
 *   render disabled with an explainer tooltip
 *
 * In dev (`NODE_ENV !== 'production'`) writes are enabled by default so
 * local exercising of the UI works without ceremony.
 */
export function writesEnabled(): boolean {
  const raw = getEnv('ADMIN_WRITES_ENABLED');
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
