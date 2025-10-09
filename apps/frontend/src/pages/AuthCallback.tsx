import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { trpc } from '@/lib/trpc';

export function AuthCallback() {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.hash.replace(/^#/, '?'));

  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // This will trigger a user sync on the backend when the user is authenticated
  const getCurrentUser = trpc.users.getCurrent.useQuery(undefined, {
    enabled: false, // We'll manually trigger this
    retry: false,
  });

  useEffect(() => {
    const handleAuthCallback = async () => {
      try {
        // Check if there's an error in the URL params first
        const error = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');

        if (error) {
          setStatus('error');
          setErrorMessage(errorDescription || 'Authentication failed');
          return;
        }

        // Handle the auth callback by getting the session
        const { data, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
          setStatus('error');
          setErrorMessage(sessionError.message);
          return;
        }

        if (data.session) {
          // Successfully authenticated - now sync user with backend
          setStatus('success');

          // Trigger user sync by making an API call
          try {
            await getCurrentUser.refetch();
          } catch (syncError) {
            console.warn('User sync failed, but authentication was successful:', syncError);
            // Don't fail the login for sync issues
          }

          // Short delay to show success message, then redirect
          setTimeout(() => {
            navigate('/', { replace: true });
          }, 1500);
        } else {
          // No session found, try to refresh
          const { error: refreshError } = await supabase.auth.refreshSession();
          if (refreshError) {
            setStatus('error');
            setErrorMessage('Failed to authenticate. Please try again.');
          } else {
            setStatus('success');
            setTimeout(() => {
              navigate('/', { replace: true });
            }, 1500);
          }
        }
      } catch (err) {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Unknown error occurred');
      }
    };

    handleAuthCallback();
  }, [searchParams, navigate, getCurrentUser.refetch]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8">
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8">
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

  // Error state
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8">
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
