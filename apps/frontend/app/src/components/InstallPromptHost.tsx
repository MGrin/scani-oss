import { InstallPromptBanner } from '@scani/ui';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Thin auth-aware wrapper around the shared `InstallPromptBanner`. Sits
 * inside the `AuthProvider` (so `useAuth()` resolves) and lets the banner
 * itself stay auth-agnostic in `@scani/ui`.
 */
export function InstallPromptHost() {
  const { user, loading } = useAuth();
  return <InstallPromptBanner isLoggedIn={!!user && !loading} />;
}
