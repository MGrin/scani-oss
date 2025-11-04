import type { Session, User } from '@supabase/supabase-js';
import { useRouter, useSegments } from 'expo-router';
import {
  createContext,
  type FC,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { setupSessionManager } from '@/services/supabase/sessionManager';
import { supabase } from '@/services/supabase/supabase';
import { logger } from '@/utils/logger';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  authenticate: (email: string) => Promise<{ error?: string }>;
  verifyCode: (email: string, token: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    logger.info('Setting up session manager');
    setupSessionManager();
  }, []);

  useEffect(() => {
    logger.info('Initializing auth state');

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);

      if (session) {
        logger.info('Session found', { userId: session.user.id, email: session.user.email });
        logger.setUser(session.user.id, session.user.email);
      } else {
        logger.info('No active session');
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      logger.info('Auth state changed', { event, userId: session?.user.id });

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);

      if (session) {
        logger.setUser(session.user.id, session.user.email);
      } else {
        logger.clearUser();
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === '(auth)';

    logger.debug('Navigation check', {
      hasSession: !!session,
      inAuthGroup,
      segments: segments.join('/'),
      userId: user?.id,
    });

    if (!session && !inAuthGroup) {
      logger.info('Redirecting to auth (no session)');
      router.replace('/(auth)');
    } else if (session && inAuthGroup) {
      logger.info('Redirecting to app (authenticated)');
      router.replace('/(app)');
    }
  }, [session, loading, segments, router.replace, user?.id]);

  const authenticate = useCallback(async (email: string): Promise<{ error?: string }> => {
    logger.info('Attempting authentication', { email });

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      logger.error('Authentication failed', error, { email });
      return { error: error.message };
    }

    logger.info('OTP sent successfully', { email });
    return {};
  }, []);

  const verifyCode = useCallback(
    async (email: string, token: string): Promise<{ error?: string }> => {
      logger.info('Verifying OTP code', { email });

      const { error } = await supabase.auth.verifyOtp({
        email,
        token,
        type: 'email',
      });

      if (error) {
        logger.error('OTP verification failed', error, { email });
        return { error: error.message };
      }

      logger.info('OTP verified successfully', { email });
      return {};
    },
    []
  );

  const signOut = useCallback(async (): Promise<void> => {
    logger.info('Signing out', { userId: user?.id });
    await supabase.auth.signOut();
    logger.info('Signed out successfully');
  }, [user?.id]);

  const value: AuthContextValue = useMemo(
    () => ({
      user,
      session,
      loading,
      authenticate,
      verifyCode,
      signOut,
    }),
    [user, session, loading, authenticate, verifyCode, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
