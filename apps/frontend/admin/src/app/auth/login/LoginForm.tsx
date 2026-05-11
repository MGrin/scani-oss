'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { completeLoginAction } from './actions';

interface Props {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeToken: string;
  next: string;
}

type Status = 'ready' | 'pending' | 'error' | 'expired';

export function LoginForm({ options, challengeToken, next }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('ready');
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setStatus('pending');
    setError(null);
    try {
      const response = await startAuthentication({ optionsJSON: options });
      const result = await completeLoginAction(response, challengeToken);
      if (!result.ok) {
        // Server's signed token has a 5-min TTL; if the user lingered the
        // signin will fail with "Challenge expired or invalid". Reloading
        // the page mints a fresh challenge.
        const expired = result.error === 'Challenge expired or invalid';
        setStatus(expired ? 'expired' : 'error');
        setError(result.error);
        return;
      }
      router.replace(next);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (status === 'expired') {
    return (
      <>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="w-full rounded-md border border-border bg-muted hover:bg-muted px-4 py-2 text-sm font-semibold"
        >
          Reload to retry
        </button>
        <div className="mt-4 text-xs text-muted-foreground">
          Sign-in challenge expired. Reload the page to start over.
        </div>
      </>
    );
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
