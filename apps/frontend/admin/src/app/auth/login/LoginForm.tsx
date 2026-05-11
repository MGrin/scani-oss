'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { completeLoginAction } from './actions';

interface Props {
  initialOptions: PublicKeyCredentialRequestOptionsJSON;
  next: string;
}

// Server-side challenge TTL is 5 min. We refresh shortly before that so a
// user who lingers on the page still has a valid challenge when they click.
// Best-effort only: if the refresh fetch fails (some mobile WebViews block
// background fetches), the initial SSR'd options remain usable until the
// underlying cookie expires.
const OPTIONS_REFRESH_MS = 4 * 60 * 1000;

type Status = 'ready' | 'pending' | 'error';

export function LoginForm({ initialOptions, next }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('ready');
  const [error, setError] = useState<string | null>(null);
  const optionsRef = useRef(initialOptions);

  const refreshOptions = useCallback(async () => {
    try {
      const res = await fetch('/auth/login/begin', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return;
      optionsRef.current = (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
    } catch {
      // Refresh is best-effort; the SSR'd options remain valid until the
      // signed-challenge cookie expires.
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void refreshOptions();
    }, OPTIONS_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refreshOptions]);

  async function onSignIn() {
    setStatus('pending');
    setError(null);
    try {
      const response = await startAuthentication({ optionsJSON: optionsRef.current });
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
    <>
      <button
        type="button"
        onClick={onSignIn}
        disabled={status === 'pending'}
        className="w-full rounded-md border border-border bg-muted hover:bg-muted disabled:opacity-50 px-4 py-2 text-sm font-semibold"
      >
        {status === 'pending' ? 'Waiting for passkey…' : 'Sign in with passkey'}
      </button>
      {error ? <div className="mt-4 text-xs text-red-300 break-words">{error}</div> : null}
    </>
  );
}
