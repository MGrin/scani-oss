import { isPWA, logPWAInfo } from '@scani/ui/lib/pwa-utils';
import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

/**
 * Auth context wired to Better-Auth. Exposes the same surface the rest of
 * the app already consumes (authenticate / verifyCode / signOut /
 * resetPassword), but under the hood uses Better-Auth's magic-link +
 * email-password flows instead of Supabase.
 *
 * The session lives in an HttpOnly cookie on the API origin. The client
 * library's useSession() hook polls /api/auth/get-session under the hood
 * so we mirror its state into our context.
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

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  authenticate: (email: string) => Promise<{ error?: string }>;
  verifyCode: (email: string, token: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    let mounted = true;
    authClient
      .getSession()
      .then((res) => {
        if (!mounted) return;
        const s = res?.data;
        if (s?.user) {
          const u: AuthUser = {
            id: s.user.id,
            email: s.user.email,
            name: s.user.name,
            image: s.user.image ?? null,
          };
          setUser(u);
          setSession({ user: u, token: s.session.token });
        } else {
          setUser(null);
          setSession(null);
        }
      })
      .catch((err) => {
        console.error('[Auth] getSession failed:', err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    // Re-check the session on window focus — covers "signed in via magic
    // link in another tab" and long-running browser sessions.
    const onFocus = () => {
      authClient.getSession().then((res) => {
        const s = res?.data;
        if (s?.user) {
          const u: AuthUser = {
            id: s.user.id,
            email: s.user.email,
            name: s.user.name,
            image: s.user.image ?? null,
          };
          setUser(u);
          setSession({ user: u, token: s.session.token });
        } else {
          setUser(null);
          setSession(null);
        }
      });
    };
    window.addEventListener('focus', onFocus);
    return () => {
      mounted = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const refreshSession = async () => {
    const res = await authClient.getSession();
    const s = res?.data;
    if (s?.user) {
      const u: AuthUser = {
        id: s.user.id,
        email: s.user.email,
        name: s.user.name,
        image: s.user.image ?? null,
      };
      setUser(u);
      setSession({ user: u, token: s.session.token });
    }
  };

  const authenticate = async (email: string) => {
    const runningAsPWA = isPWA();
    if (import.meta.env.DEV) {
      logPWAInfo();
      console.log(`[Auth] Running as PWA: ${runningAsPWA}`);
    }

    // PWAs get a 6-digit code instead of a magic link: clicking a link in
    // an installed standalone app bounces the user out to the system browser
    // and breaks the session. Browsers keep the magic-link flow.
    if (runningAsPWA) {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
      });
      if (error) {
        return { error: error.message || 'Failed to send code' };
      }
      return {};
    }

    const callbackURL = `${window.location.origin}/auth/callback`;
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL,
    });
    if (error) {
      return { error: error.message || 'Failed to send magic link' };
    }
    return {};
  };

  const verifyCode = async (email: string, code: string) => {
    const { error } = await authClient.signIn.emailOtp({ email, otp: code });
    if (error) {
      return { error: error.message || 'Invalid code' };
    }
    await refreshSession();
    return {};
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    setUser(null);
    setSession(null);
    // Wipe React-Query cache so a second user logging in on the same
    // browser can't see the previous user's holdings/accounts flash on
    // mount before the fresh fetch lands.
    queryClient.clear();
  };

  const resetPassword = async (_email: string) => {
    // Magic-link flow: there's no password to reset. Surface gracefully.
    return { error: 'Password reset is not used; sign in with a magic link instead' };
  };

  const value = {
    user,
    session,
    loading,
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
