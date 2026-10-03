import { safeReturnTarget } from '@scani/shared/utils/safe-redirect';
import type { NavigateFunction } from 'react-router-dom';

function originOf(configured: string | undefined): string[] {
  if (!configured) return [];
  try {
    return [new URL(configured).origin];
  } catch {
    return [];
  }
}

/**
 * Origins a sign-in may send the browser back to: the Cloud console and the
 * admin app, each only when configured.
 */
const CLOUD_ORIGINS = originOf(import.meta.env.VITE_CLOUD_URL);
const RETURN_ORIGINS: readonly string[] = [
  ...CLOUD_ORIGINS,
  ...originOf(import.meta.env.VITE_ADMIN_URL),
];

export function safeReturnTo(input: string | null | undefined, fallback: string): string {
  return safeReturnTarget(input, fallback, RETURN_ORIGINS);
}

/** Whether a validated return target is the Cloud console, so sign-in can say so (SC-1520). */
export function isCloudReturn(target: string): boolean {
  if (target.startsWith('/')) return false;
  return CLOUD_ORIGINS.some((origin) => originOf(target)[0] === origin);
}

export function goToReturnTarget(target: string, navigate: NavigateFunction): void {
  if (target.startsWith('/')) navigate(target, { replace: true });
  else window.location.assign(target);
}
