import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authClient } from '@/lib/auth-client';
import { trpc } from '@/lib/trpc';

/**
 * Better-Auth magic-link callback.
 *
 * The backend's /api/auth/magic-link/verify handler validates the token,
 * mints a session cookie, and 302-redirects here. By the time this
 * component mounts, the cookie should already be set and
 * authClient.getSession() should return a populated session — we just
 * verify that's true and redirect onward.
 */
export function AuthCallback() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);

  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const returnTo = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';

  // Warm the backend user cache when the session is valid.
  const getCurrentUser = trpc.users.getCurrent.useQuery(undefined, {
    enabled: false,
    retry: false,
  });

  useEffect(() => {
    const run = async () => {
      try {
        const error = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');
        if (error) {
          setStatus('error');
          setErrorMessage(errorDescription || 'Authentication failed');
          return;
        }

        const session = await authClient.getSession();
        if (session?.data?.user) {
          setStatus('success');
          try {
            await getCurrentUser.refetch();
          } catch (syncError) {
            console.warn('User sync failed, but authentication was successful:', syncError);
          }
          navigate(returnTo, { replace: true });
          return;
        }

        // No session — the magic link may have expired before the user
        // landed here, or cookies were blocked.
        setStatus('error');
        setErrorMessage(
          'Your sign-in link has expired or could not be verified. Please request a new one.'
        );
      } catch (err) {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Unknown error occurred');
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, returnTo]);

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
