'use client';

import { safeRedirectPath } from '@scani/shared';
import { startAuthentication } from '@simplewebauthn/browser';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { beginLoginAction, completeLoginAction } from './actions';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Validated against open-redirect chains: any non-same-origin target
  // (`https://…`, `//…`, `javascript:…`) falls back to `/`.
  const next = safeRedirectPath(searchParams.get('next'), '/');
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setStatus('pending');
    setError(null);
    try {
      const options = await beginLoginAction();
      const response = await startAuthentication({ optionsJSON: options });
      const result = await completeLoginAction(response);
      if (!result.ok) {
        setStatus('error');
        setError(result.error);
        return;
      }
      router.replace(next);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
        <h1 className="text-lg font-semibold mb-1">scani · admin</h1>
        <p className="text-xs text-neutral-400 mb-6">
          Sign in with your passkey to access the dashboard.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          disabled={status === 'pending'}
          className="w-full rounded-md border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 px-4 py-2 text-sm font-semibold"
        >
          {status === 'pending' ? 'Waiting for passkey…' : 'Sign in with passkey'}
        </button>
        {error ? <div className="mt-4 text-xs text-red-300 break-words">{error}</div> : null}
      </div>
    </div>
  );
}
