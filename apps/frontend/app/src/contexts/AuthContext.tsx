import { isPWA, logPWAInfo } from '@scani/ui/lib/pwa-utils';
import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '@/lib/auth-client';
import {
  AUTH_CALL_TIMEOUT_MS,
  type AuthFailureKind,
  authFailureMessage,
  classifyAuthFailure,
  isOnline,
  withDeadline,
} from '@/lib/auth-network';
import {
  type CachedAuthUser,
  clearCachedUser,
  readCachedUser,
  writeCachedUser,
} from '@/lib/session-cache';

/**
 * Auth context wired to Better-Auth. Exposes the same surface the rest of
 * the app already consumes (authenticate / verifyCode / signOut /
 * resetPassword), but under the hood uses Better-Auth's magic-link +
 * email-password flows instead of Supabase.
 *
 * The session lives in an HttpOnly cookie on api.scani.xyz. The client
 * library's useSession() hook polls /api/auth/get-session under the hood
 * so we mirror its state into our context.
 *
 * **"Could not ask" is not an answer (SC-78 §2).** The session probe used to
 * `catch` a failure, log it, and fall through to `user === null` — which every
 * consumer reads as "signed out". Offline, that put the installed PWA on the
 * sign-in screen while the session was in fact intact. So the probe now has
 * four outcomes rather than two, and `unreachable` is its own state that no
 * screen is allowed to render as a sign-out. Same shape as SC-76's fix in the
 * cloud console: the bug there was also a binary that swept every unrecognised
 * outcome into one bucket.
 *
 * Every call out is bounded (see `lib/auth-network.ts`) — nothing here can
 * leave a caller awaiting forever, which is the whole of SC-78 §1.
 */

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
}

/**
 * - `loading` — the first probe has not answered yet.
 * - `authenticated` / `anonymous` — the server answered.
 * - `unreachable` — the server did not answer. Says nothing about the session.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unreachable';

export interface AuthAttemptResult {
  error?: string;
  /** Present on failure. `offline` / `timeout` / `unreachable` are worth
   *  retrying by themselves; `server` is not. */
  kind?: AuthFailureKind;
}

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  status: AuthStatus;
  /** Who this device last saw signed in. A hint for wording only — never a
   *  credential, and never a substitute for `user`. */
  lastKnownUser: CachedAuthUser | null;
  /** Re-ask the server. Used by the offline screen's Retry, and automatically
   *  when connectivity returns. */
  retrySession: () => Promise<void>;
  authenticate: (email: string) => Promise<AuthAttemptResult>;
  verifyCode: (email: string, token: string) => Promise<AuthAttemptResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function toAuthUser(user: {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [lastKnownUser, setLastKnownUser] = useState<CachedAuthUser | null>(() => readCachedUser());
  const queryClient = useQueryClient();
  const mounted = useRef(true);

  const resolveSession = useCallback(async () => {
    try {
      const res = await withDeadline(authClient.getSession(), AUTH_CALL_TIMEOUT_MS);
      if (!mounted.current) return;
      const s = res?.data;
      if (s?.user) {
        const u = toAuthUser(s.user);
        setUser(u);
        setSession({ user: u, token: s.session.token });
        setStatus('authenticated');
        writeCachedUser(u);
        setLastKnownUser(u);
        return;
      }
      // A real "no session" — the only place the hint is allowed to be cleared
      // by a probe, because it is the only probe outcome that contradicts it.
      setUser(null);
      setSession(null);
      setStatus('anonymous');
      clearCachedUser();
      setLastKnownUser(null);
    } catch (error) {
      if (!mounted.current) return;
      console.error('[Auth] getSession failed:', error);
      // Deliberately leaves `user` alone. Signing someone out because their
      // train went into a tunnel is the defect this branch exists to stop.
      setStatus('unreachable');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void resolveSession();

    // Re-check on focus and when the network comes back — the first covers
    // "signed in via magic link in another tab" and long-running sessions, the
    // second is what turns an `unreachable` shell back into the app without a
    // force-quit.
    const recheck = () => {
      void resolveSession();
    };
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', recheck);
      window.removeEventListener('online', recheck);
    };
  }, [resolveSession]);

  /** Wraps a better-auth call so it always settles and always yields wording a
   *  reader can act on. */
  const attempt = async (
    run: () => Promise<{ error?: { message?: string } | null }>
  ): Promise<AuthAttemptResult> => {
    if (!isOnline()) {
      // Asking a dead network to send an email wastes the whole deadline
      // before saying the one thing the reader already needs to hear.
      return { error: authFailureMessage(t, 'offline'), kind: 'offline' };
    }
    try {
      const { error } = await withDeadline(run(), AUTH_CALL_TIMEOUT_MS);
      if (error) {
        const kind = classifyAuthFailure(error, isOnline());
        return { error: authFailureMessage(t, kind, error.message), kind };
      }
      return {};
    } catch (error) {
      const kind = classifyAuthFailure(error, isOnline());
      return { error: authFailureMessage(t, kind), kind };
    }
  };

  const authenticate = async (email: string): Promise<AuthAttemptResult> => {
    const runningAsPWA = isPWA();
    if (import.meta.env.DEV) {
      logPWAInfo();
      console.log(`[Auth] Running as PWA: ${runningAsPWA}`);
    }

    // PWAs get a 6-digit code instead of a magic link: clicking a link in
    // an installed standalone app bounces the user out to the system browser
    // and breaks the session. Browsers keep the magic-link flow.
    if (runningAsPWA) {
      return attempt(() => authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }));
    }

    const callbackURL = `${window.location.origin}/auth/callback`;
    return attempt(() => authClient.signIn.magicLink({ email, callbackURL }));
  };

  const verifyCode = async (email: string, code: string): Promise<AuthAttemptResult> => {
    const result = await attempt(() => authClient.signIn.emailOtp({ email, otp: code }));
    if (result.error) return result;
    await resolveSession();
    return {};
  };

  const handleSignOut = async () => {
    try {
      await withDeadline(authClient.signOut(), AUTH_CALL_TIMEOUT_MS);
    } catch (error) {
      // A sign-out that cannot reach the server still clears this device.
      // Leaving the user staring at a spinner would be the §1 wedge again.
      console.error('[Auth] signOut failed:', error);
    }
    setUser(null);
    setSession(null);
    setStatus('anonymous');
    clearCachedUser();
    setLastKnownUser(null);
    // Wipe React-Query cache so a second user logging in on the same
    // browser can't see the previous user's holdings/accounts flash on
    // mount before the fresh fetch lands.
    queryClient.clear();
  };

  const resetPassword = async (_email: string) => {
    // Magic-link flow: there's no password to reset. Surface gracefully.
    // Not user-facing: nothing in the app calls this, and better-auth's magic
    // link is the only way in. Left as a developer-addressed string on purpose.
    return { error: 'Password reset is not used; sign in with a magic link instead' };
  };

  const value = {
    user,
    session,
    loading: status === 'loading',
    status,
    lastKnownUser,
    retrySession: resolveSession,
    authenticate,
    verifyCode,
    signOut: handleSignOut,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
