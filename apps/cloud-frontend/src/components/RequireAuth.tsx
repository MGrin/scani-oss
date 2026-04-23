import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

/**
 * Redirect to /auth if the Better-Auth session is missing.
 *
 * We rely on Better-Auth's `useSession` hook which reads the signed
 * session cookie asynchronously. While `isPending`, render a minimal
 * placeholder so the app doesn't flash the login screen on every reload.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!data?.user) {
    const returnTo = location.pathname + location.search;
    return <Navigate to={`/auth?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return <>{children}</>;
}
