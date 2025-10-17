import type { Session, User } from "@supabase/supabase-js";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { isPWA, logPWAInfo } from "@/lib/pwa-utils";
import { supabase } from "@/lib/supabase";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  authenticate: (email: string) => Promise<{ error?: string }>;
  verifyCode: (email: string, token: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const authenticate = async (email: string) => {
    // Check if running in PWA
    const runningAsPWA = isPWA();

    // Log PWA detection info for debugging
    if (import.meta.env.DEV) {
      logPWAInfo();
      console.log(`[Auth] Running as PWA: ${runningAsPWA}`);
    }

    if (runningAsPWA) {
      // For PWA: Send magic CODE (no redirect needed)
      console.log("[Auth] PWA detected: Sending magic code");
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          data: {
            email_type: "otp",
            EMailType: "otp",
          },
        },
      });

      if (error) {
        return { error: error.message };
      }

      return {};
    }

    // For browser: Send magic LINK with redirect
    const redirectUrl = `${window.location.origin}/auth/callback?mode=magic-link`;
    console.log(
      `[Auth] Browser detected: Sending magic link with redirect to: ${redirectUrl}`
    );

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectUrl,
        data: {
          email_type: "magic_link",
          EMailType: "magic_link",
        },
      },
    });

    if (error) {
      return { error: error.message };
    }

    return {};
  };

  const verifyCode = async (email: string, token: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });

    if (error) {
      return { error: error.message };
    }

    return {};
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      return { error: error.message };
    }

    return {};
  };

  const value = {
    user,
    session,
    loading,
    authenticate,
    verifyCode,
    signOut,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
