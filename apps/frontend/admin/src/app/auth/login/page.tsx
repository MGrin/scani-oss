'use client';

import { safeRedirectPath } from '@scani/shared';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { beginLoginAction, completeLoginAction } from './actions';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

// Server-side challenge TTL is 5 min; refresh a bit before that to avoid
// a stale challenge if the user lingers on the page.
const OPTIONS_REFRESH_MS = 4 * 60 * 1000;

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Validated against open-redirect chains: any non-same-origin target
  // (`https://…`, `//…`, `javascript:…`) falls back to `/`.
  const next = safeRedirectPath(searchParams.get('next'), '/');
  const [status, setStatus] = useState<'preparing' | 'ready' | 'pending' | 'error'>('preparing');
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<PublicKeyCredentialRequestOptionsJSON | null>(null);

  // iOS Safari (and stricter Android browsers) require `navigator.credentials.get()`
  // to run inside the click's transient activation. Awaiting a Server Action first
  // burns the activation, so the OS passkey sheet never appears. We pre-fetch the
  // challenge on mount and refresh it periodically so the click handler can call
  // `startAuthentication` synchronously.
  const prepareOptions = useCallback(async () => {
    try {
      const opts = await beginLoginAction();
      setOptions(opts);
      setStatus((prev) => (prev === 'pending' ? prev : 'ready'));
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void prepareOptions();
    const interval = setInterval(() => {
      void prepareOptions();
    }, OPTIONS_REFRESH_MS);
    return () => clearInterval(interval);
  }, [prepareOptions]);

  async function onSignIn() {
    if (!options) {
      setError('Passkey challenge is still loading. Try again in a moment.');
      return;
    }
    setStatus('pending');
    setError(null);
    try {
      const response = await startAuthentication({ optionsJSON: options });
      const result = await completeLoginAction(response);
      if (!result.ok) {
        setStatus('error');
        setError(result.error);
        void prepareOptions();
        return;
      }
      router.replace(next);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
      void prepareOptions();
    }
  }

  const buttonDisabled = status === 'pending' || status === 'preparing' || !options;
  const buttonLabel =
    status === 'pending'
      ? 'Waiting for passkey…'
      : status === 'preparing' || !options
        ? 'Preparing…'
        : 'Sign in with passkey';

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card/40 p-6">
        <h1 className="text-lg font-semibold mb-1">scani · admin</h1>
        <p className="text-xs text-muted-foreground mb-6">
          Sign in with your passkey to access the dashboard.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          disabled={buttonDisabled}
          className="w-full rounded-md border border-border bg-muted hover:bg-muted disabled:opacity-50 px-4 py-2 text-sm font-semibold"
        >
          {buttonLabel}
        </button>
        {error ? <div className="mt-4 text-xs text-red-300 break-words">{error}</div> : null}
      </div>
    </div>
  );
}
