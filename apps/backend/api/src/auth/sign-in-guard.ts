import { APIError } from 'better-auth/api';

type SignInGuard = (userId: string) => Promise<boolean>;

const allowAll: SignInGuard = async () => true;

let guard: SignInGuard = allowAll;

/**
 * Thrown from the session `create.before` hook when the guard refuses. An
 * `APIError`, so every sign-in route answers a 403 rather than a 500, with a
 * message that names no reason.
 */
export class SignInRefused extends APIError {
  constructor() {
    super('FORBIDDEN', { message: 'Sign-in refused', code: 'SIGN_IN_REFUSED' });
  }
}

/** Replaces the guard every new session is checked against. One slot; the last call wins. */
export function registerSignInGuard(next: SignInGuard): void {
  guard = next;
}

export function isSignInAllowed(userId: string): Promise<boolean> {
  return guard(userId);
}
