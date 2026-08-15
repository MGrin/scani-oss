import { zodResolver } from '@hookform/resolvers/zod';
import { emailSchema, safeRedirectPath } from '@scani/shared';
import { MagicCodeInput } from '@scani/ui/components/MagicCodeInput';
import { ScaniLogo } from '@scani/ui/components/ScaniLogo';
import { isPWA } from '@scani/ui/lib/pwa-utils';
import { Alert, AlertDescription } from '@scani/ui/ui/alert';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { CloudOff, Loader2, Mail } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '@/contexts/AuthContext';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

const authSchema = z.object({
  email: emailSchema,
});

type AuthFormData = z.infer<typeof authSchema>;

/**
 * Sign-in, and the app's most exposed screen (SC-78 §1).
 *
 * In `display-mode: standalone` there is no reload button and no URL bar, so a
 * request with no deadline is not a slow screen — it is a dead end whose only
 * exit is the app switcher, on the first thing a person sees. Every call from
 * here now settles (`lib/auth-network.ts` bounds them), the error says which
 * half is broken and what to tap, and a send that failed because the device was
 * offline is retried on its own the moment the network returns.
 */
export function Auth() {
  const { user, loading, authenticate, verifyCode } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEmailSent, setIsEmailSent] = useState(false);
  const [userEmail, setUserEmail] = useState<string>('');
  const online = useOnlineStatus();
  /** An address whose send died for want of a network, waiting for one. Held
   *  in a ref so re-arming it cannot re-trigger the retry effect — the effect
   *  fires on connectivity *changing*, and nothing else. */
  const pendingRetryEmail = useRef<string | null>(null);

  // Get return URL from query params, validated against open-redirect
  // chains: must be a same-origin path, never an absolute or
  // protocol-relative URL.
  const returnTo = safeRedirectPath(searchParams.get('returnTo'), '/');

  // Leave /auth as soon as the session resolves. Covers two cases the
  // static "check your email" screen otherwise strands the user in:
  // refreshing this tab after signing in via the magic link in another
  // tab, and AuthContext's window-focus re-check flipping us to signed-in.
  useEffect(() => {
    if (!loading && user) navigate(returnTo, { replace: true });
  }, [loading, user, navigate, returnTo]);

  // Detect if running in PWA
  const runningAsPWA = isPWA();

  // Log for debugging
  console.log('[Auth Page] Running as PWA:', runningAsPWA);

  const emailId = useId();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AuthFormData>({
    resolver: zodResolver(authSchema),
  });

  const sendTo = useCallback(
    async (email: string) => {
      setIsLoading(true);
      setError(null);
      setUserEmail(email);

      const result = await authenticate(email);

      // Only a failure the network itself caused is worth waiting on: a
      // rejected address will still be rejected when the wifi is back.
      pendingRetryEmail.current = result.kind === 'offline' ? email : null;

      if (result.error) setError(result.error);
      else setIsEmailSent(true);

      setIsLoading(false);
    },
    [authenticate]
  );

  // Recovery, not just an error message. The reader may have put the phone
  // down; when the network returns the send they already asked for goes out
  // without them having to find this screen again.
  useEffect(() => {
    if (!online) return;
    const email = pendingRetryEmail.current;
    if (!email) return;
    pendingRetryEmail.current = null;
    void sendTo(email);
  }, [online, sendTo]);

  const onSubmit = (data: AuthFormData) => sendTo(data.email);

  const handleCodeSubmit = async (code: string) => {
    setError(null);
    const result = await verifyCode(userEmail, code);

    if (result.error) {
      setError(result.error);
      throw new Error(result.error);
    } else {
      // Successfully authenticated, redirect to return URL or dashboard
      navigate(returnTo, { replace: true });
    }
  };

  const handleResendCode = async () => {
    setError(null);
    const result = await authenticate(userEmail);
    if (result.error) {
      setError(result.error);
      throw new Error(result.error);
    }
  };

  if (isEmailSent) {
    if (runningAsPWA) {
      // Show code input for PWA users
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
          <div className="w-full max-w-md space-y-8 flex flex-col items-center">
            <div className="flex items-center gap-3">
              <ScaniLogo className="h-10 w-10" />
              <span className="text-3xl font-semibold tracking-tight">Scani</span>
            </div>
            <Card className="w-full">
              <CardHeader className="space-y-1">
                <CardTitle className="text-2xl text-center">Enter verification code</CardTitle>
                <CardDescription className="text-center">
                  We've sent a 6-digit code to {userEmail}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MagicCodeInput
                  onSubmit={handleCodeSubmit}
                  onResend={handleResendCode}
                  isLoading={isLoading}
                  error={error}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setIsEmailSent(false);
                    setError(null);
                  }}
                  className="w-full mt-4"
                >
                  Use a different email
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      );
    }

    // Show magic link message for browser users
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
        <div className="w-full max-w-md space-y-8 flex flex-col items-center">
          <div className="flex items-center gap-3">
            <ScaniLogo className="h-10 w-10" />
            <span className="text-3xl font-semibold tracking-tight">Scani</span>
          </div>
          <Card className="w-full">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl text-center">Check your email</CardTitle>
              <CardDescription className="text-center">
                We've sent you a magic link to sign in
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center space-y-4">
              <Mail className="mx-auto h-12 w-12 text-blue-600" />
              <p className="text-sm text-muted-foreground">
                Click the link in your email to access your account. If this is your first time,
                we'll create an account for you automatically.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsEmailSent(false);
                  setError(null);
                }}
                className="w-full"
              >
                Send another email
              </Button>
            </CardContent>
          </Card>
        </div>
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
      <div className="w-full max-w-md space-y-8 flex flex-col items-center">
        <div className="flex items-center gap-3">
          <ScaniLogo className="h-10 w-10" />
          <span className="text-3xl font-semibold tracking-tight">Scani</span>
        </div>
        <Card className="w-full">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">Welcome</CardTitle>
            <CardDescription className="text-center">
              Enter your email to sign in or create an account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {/* Said before the tap, not after it. The failure it predicts is
                  certain, and this is the one screen where an avoidable
                  round-trip used to cost two minutes of a spinner. */}
              {!online && (
                <Alert>
                  <AlertDescription className="flex items-start gap-2">
                    <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      You’re offline. We’ll send your code as soon as the connection is back.
                    </span>
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor={emailId}>Email</Label>
                <Input
                  id={emailId}
                  type="email"
                  placeholder="Enter your email address"
                  {...register('email')}
                  disabled={isLoading}
                />
                {errors.email && <p className="text-sm text-red-600">{errors.email.message}</p>}
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue with Email
              </Button>

              <div className="text-center text-sm text-muted-foreground">
                <p>
                  {runningAsPWA
                    ? "We'll send you a 6-digit code to sign in."
                    : "We'll send you a secure magic link to sign in."}{' '}
                  <br />
                  New to Scani? Your account will be created automatically.
                </p>
              </div>
              {import.meta.env.DEV && (
                <div className="text-center text-xs text-muted-foreground mt-2">
                  Mode: {runningAsPWA ? 'PWA (Code)' : 'Browser (Link)'}
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
