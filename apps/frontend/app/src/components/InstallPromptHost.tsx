import { InstallPromptBanner } from '@scani/ui';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Thin auth-aware wrapper around the shared `InstallPromptBanner`. Sits
 * inside the `AuthProvider` (so `useAuth()` resolves) and lets the banner
 * itself stay auth-agnostic in `@scani/ui`.
 *
 * Never on the demo: its visitor is signed in as a fictional person, and
 * installing would put a read-only sample on their home screen in place of
 * the app the demo is there to sell (SC-1520).
 */
export function InstallPromptHost() {
  const { user, loading, isDemo } = useAuth();
  return <InstallPromptBanner isLoggedIn={!!user && !loading && !isDemo} />;
}
