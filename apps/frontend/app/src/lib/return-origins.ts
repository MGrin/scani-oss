import { safeReturnTarget } from '@scani/shared/utils/safe-redirect';
import type { NavigateFunction } from 'react-router-dom';

function cloudOrigin(): string[] {
  const configured = import.meta.env.VITE_CLOUD_URL;
  if (!configured) return [];
  try {
    return [new URL(configured).origin];
  } catch {
    return [];
  }
}

/** Origins a sign-in may send the browser back to: the Cloud console, when configured. */
const RETURN_ORIGINS: readonly string[] = cloudOrigin();

export function safeReturnTo(input: string | null | undefined, fallback: string): string {
  return safeReturnTarget(input, fallback, RETURN_ORIGINS);
}

export function goToReturnTarget(target: string, navigate: NavigateFunction): void {
  if (target.startsWith('/')) navigate(target, { replace: true });
  else window.location.assign(target);
}
