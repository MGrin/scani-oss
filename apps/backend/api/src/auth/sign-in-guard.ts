import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
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

const logger = createComponentLogger('sign-in-guard');

/**
 * A guard that throws fails CLOSED: no session is created. That is only safe if
 * it is loud, because a guard bug locks every user out, so it is logged at
 * error level and sent to Sentry before the sign-in fails.
 */
export async function isSignInAllowed(userId: string): Promise<boolean> {
  try {
    return await guard(userId);
  } catch (error) {
    logger.error({ err: error, userId }, 'sign-in guard failed; sign-in refused');
    captureException(error, { component: 'sign-in-guard' });
    throw error;
  }
}
