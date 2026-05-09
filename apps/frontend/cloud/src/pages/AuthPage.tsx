import { safeRedirectPath } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

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

  const sendOtp = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
      if (res.error) throw new Error(res.error.message || 'Failed to send code');
      setStage('otp');
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
      navigate(returnTo, { replace: true });
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
