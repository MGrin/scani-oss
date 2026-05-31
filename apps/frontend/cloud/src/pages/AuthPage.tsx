import { safeRedirectPath } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

// Backend rate-limits OTP sends per email; the cooldown here is just
// UX feedback so the user doesn't bash "resend" and trip the server-
// side limit. 30s is a comfortable middle ground — quick enough that
// a missed-email retry doesn't stall, slow enough that double-tapping
// can't burn through the budget.
const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Single-screen auth flow:
 *   1. User enters email → we send an email OTP (6-digit code).
 *   2. User enters the OTP → session cookie is set, redirect to returnTo.
 *
 * Email-OTP is preferred over magic-link here because cloud operators are
 * often on machines where opening the link from a phone is inconvenient.
 * The magic-link plugin is still enabled server-side for future deep links.
 */
export function AuthPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Validated against open-redirect chains: any non-same-origin target
  // (`https://…`, `//…`, `javascript:…`) falls back to `/keys`.
  const returnTo = safeRedirectPath(params.get('returnTo'), '/keys');

  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'email' | 'otp'>('email');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Already-authenticated visitors (valid session cookie, e.g. opened
  // /auth directly or bounced here by the guard mid-login) get sent on to
  // their destination once the session resolves.
  const { data: sessionData } = authClient.useSession();
  useEffect(() => {
    if (sessionData?.user) navigate(returnTo, { replace: true });
  }, [sessionData, navigate, returnTo]);

  // Tick the resend cooldown down to zero. Cleared on unmount.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = window.setInterval(() => {
      setResendCooldown((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendCooldown]);

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    if (resendCooldown > 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (res.error) throw new Error(res.error.message || 'Failed to send code');
      setStage('otp');
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    if (resendCooldown > 0 || !email) return;
    setError(null);
    setLoading(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (res.error) throw new Error(res.error.message || 'Failed to send code');
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await authClient.signIn.emailOtp({ email, otp });
      if (res.error) throw new Error(res.error.message || 'Invalid code');
      // Full reload, not a client-side navigate: the RequireAuth guard reads
      // authClient.useSession(), whose cached atom hasn't picked up the
      // just-set session cookie yet — an SPA navigate races it and bounces
      // straight back to /auth. A hard load re-initialises the guard from the
      // live cookie.
      window.location.replace(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Scani Cloud</CardTitle>
          <CardDescription>
            {stage === 'email'
              ? 'Sign in to manage your Cloud API keys and usage.'
              : `Enter the 6-digit code we sent to ${email}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stage === 'email' ? (
            <form onSubmit={sendOtp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  // iOS zooms into inputs with font-size < 16px on focus.
                  // Force 16px on mobile, drop back to the design-system
                  // 14px on sm+ where the zoom heuristic doesn't apply.
                  className="text-base sm:text-sm"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading || !email}>
                {loading ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="otp">Verification code</Label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="text-center text-lg tracking-[0.4em]"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading || otp.length !== 6}>
                {loading ? 'Verifying…' : 'Sign in'}
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                onClick={resendOtp}
                disabled={loading || resendCooldown > 0}
              >
                {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
              </button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setStage('email');
                  setOtp('');
                  setError(null);
                }}
              >
                Use a different email
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
