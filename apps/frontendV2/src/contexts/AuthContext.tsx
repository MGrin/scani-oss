import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { isPWA, logPWAInfo } from '@/lib/pwa-utils';

/**
 * Auth context wired to Better-Auth. Exposes the same surface the rest of
 * the app already consumes (authenticate / verifyCode / signOut /
 * resetPassword), but under the hood uses Better-Auth's magic-link +
 * email-password flows instead of Supabase.
 *
 * The session lives in an HttpOnly cookie on api.scani.xyz. The client
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

  const authenticate = async (email: string) => {
    const runningAsPWA = isPWA();
    if (import.meta.env.DEV) {
      logPWAInfo();
      console.log(`[Auth] Running as PWA: ${runningAsPWA}`);
    }

    // Magic link is our sole auth flow. Better-Auth handles the email;
    // callbackURL is where the user lands after clicking the link.
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

  /**
   * Legacy Supabase API kept for back-compat with existing components.
   * Better-Auth's magic-link verification happens server-side on GET
   * /api/auth/magic-link/verify, so client-side verifyCode is a no-op.
   */
  const verifyCode = async (_email: string, _code: string) => {
    return { error: 'Codes are no longer supported — use the magic link from your email' };
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    setUser(null);
    setSession(null);
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
