import { LoadingSpinner } from '@scani/ui/ui/loading';
import type React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ServerUnreachable } from '@/components/ServerUnreachable';
import { useAuth } from '@/contexts/AuthContext';

/**
 * The auth gate, and the one place that decides what "we could not ask" looks
 * like.
 *
 * Three outcomes, not two (SC-78 §2): the server said yes, the server said no,
 * or the server did not answer. The third used to collapse into the second and
 * redirected to `/auth`, which told an offline reader they had been logged out
 * when they had not.
 */

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, status, lastKnownUser, retrySession } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (status === 'unreachable') {
    return <ServerUnreachable email={lastKnownUser?.email ?? null} onRetry={retrySession} />;
  }

  if (!user) {
    // Redirect to auth page with return url
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
