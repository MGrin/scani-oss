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
 * admin app, each only when configured. Read per call, not at import: the
 * build inlines both either way, and a test that loads this module before
 * another sets the variables would otherwise freeze an empty list (SC-1752).
 */
const cloudOrigins = (): string[] => originOf(import.meta.env.VITE_CLOUD_URL);
const returnOrigins = (): string[] => [
  ...cloudOrigins(),
  ...originOf(import.meta.env.VITE_ADMIN_URL),
];

export function safeReturnTo(input: string | null | undefined, fallback: string): string {
  return safeReturnTarget(input, fallback, returnOrigins());
}

/** Whether a validated return target is the Cloud console, so sign-in can say so (SC-1520). */
export function isCloudReturn(target: string): boolean {
  if (target.startsWith('/')) return false;
  return cloudOrigins().some((origin) => originOf(target)[0] === origin);
}

export function goToReturnTarget(target: string, navigate: NavigateFunction): void {
  if (target.startsWith('/')) navigate(target, { replace: true });
  else window.location.assign(target);
}
