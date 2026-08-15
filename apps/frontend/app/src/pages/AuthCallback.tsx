import { Alert, AlertDescription } from '@scani/ui/ui/alert';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Better-Auth magic-link callback.
 *
 * The backend's /api/auth/magic-link/verify handler validates the token,
 * mints a session cookie, and 302-redirects here. By the time this
 * component mounts the cookie is already set, so all this screen does is
 * wait for the answer and move on.
 *
 * **It reads `AuthProvider`'s answer rather than asking its own** (SC-163).
 * `AuthProvider` mounts above the router and probes on mount, so a second
 * `getSession()` here was a duplicate of a request already in flight — two
 * probes, one answer, on the screen with the least slack in the whole app.
 *
 * It also used to `await` a `users.getCurrent` refetch before navigating, to
 * "warm the backend user cache". That warm cost a full round trip on the
 * critical path and bought nothing: `getCurrent` only returns the row
 * `requireAuth` has already loaded, and every screen behind this one calls a
 * procedure that loads it anyway. On the magic-link landing that awaited call
 * delayed the navigation, and with it the interface chunk, the dashboard
 * query and the net-worth series behind it (SC-164).
 */
export function AuthCallback() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);

  const navigate = useNavigate();
  const { status: authStatus } = useAuth();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const returnTo = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';

  const linkError = searchParams.get('error');
  const linkErrorDescription = searchParams.get('error_description');

  useEffect(() => {
    if (linkError) {
      setStatus('error');
      setErrorMessage(linkErrorDescription || 'Authentication failed');
      return;
    }
    if (authStatus === 'loading') return;

    if (authStatus === 'authenticated') {
      setStatus('success');
      navigate(returnTo, { replace: true });
      return;
    }

    setStatus('error');
    setErrorMessage(
      // "We could not ask" is not "you are not signed in" (SC-78 §2). Telling
      // someone on a dead connection that their link expired sends them to
      // request another one that will not arrive either.
      authStatus === 'unreachable'
        ? "We couldn't reach the server to finish signing you in. Check your connection and try the link again."
        : 'Your sign-in link has expired or could not be verified. Please request a new one.'
    );
  }, [authStatus, linkError, linkErrorDescription, navigate, returnTo]);

  if (status === 'loading') {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: 'max(3rem, calc(3rem + env(safe-area-inset-top)))',
          paddingBottom: 'max(3rem, calc(3rem + env(safe-area-inset-bottom)))',
          paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
          paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
        }}
      >
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Signing you in...</CardTitle>
            <CardDescription className="text-center">
              Please wait while we verify your authentication
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-blue-600" />
            <p className="text-sm text-muted-foreground">This should only take a moment.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
        style={{
          paddingTop: 'max(3rem, calc(3rem + env(safe-area-inset-top)))',
          paddingBottom: 'max(3rem, calc(3rem + env(safe-area-inset-bottom)))',
          paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
          paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
        }}
      >
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Welcome!</CardTitle>
            <CardDescription className="text-center">
              You've been successfully signed in
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <CheckCircle className="mx-auto h-12 w-12 text-green-600" />
            <p className="text-sm text-muted-foreground">Redirecting you to your dashboard...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
      style={{
        paddingTop: 'max(3rem, calc(3rem + env(safe-area-inset-top)))',
        paddingBottom: 'max(3rem, calc(3rem + env(safe-area-inset-bottom)))',
        paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
        paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
      }}
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl text-center">Authentication Error</CardTitle>
          <CardDescription className="text-center">
            There was a problem signing you in
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-red-600" />
          </div>

          {errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Button asChild className="w-full">
              <Link to="/auth">Try again</Link>
            </Button>
          </div>

          <div className="text-center text-sm text-muted-foreground">
            <p>If you continue to have issues, please contact support.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
