'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { Suspense, useState } from 'react';
import { beginBootstrapAction, completeBootstrapAction } from './actions';

export const dynamic = 'force-dynamic';

export default function BootstrapPage() {
  return (
    <Suspense>
      <BootstrapInner />
    </Suspense>
  );
}

interface Secrets {
  credentialId: string;
  publicKey: string;
}

function BootstrapInner() {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'pending' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);

  async function onRegister() {
    setStatus('pending');
    setError(null);
    try {
      const begin = await beginBootstrapAction(token);
      if (!begin.ok) {
        setStatus('error');
        setError(begin.error);
        return;
      }
      const response = await startRegistration({ optionsJSON: begin.options });
      const result = await completeBootstrapAction(token, response);
      if (!result.ok) {
        setStatus('error');
        setError(result.error);
        return;
      }
      setSecrets({
        credentialId: result.credentialId,
        publicKey: result.publicKey,
      });
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900/40 p-6 space-y-6">
        <div>
          <h1 className="text-lg font-semibold mb-1">scani · admin bootstrap</h1>
          <p className="text-xs text-neutral-400">
            One-shot passkey registration. Displays the secrets once; copy them into GitHub Actions
            / Cloudflare Pages secrets, then remove <code>ADMIN_BOOTSTRAP_TOKEN</code>
            to permanently lock this route.
          </p>
        </div>

        {status !== 'done' ? (
          <>
            <label className="block text-xs text-neutral-400">
              Bootstrap token
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={status === 'pending'}
                className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
              />
            </label>
            <button
              type="button"
              onClick={onRegister}
              disabled={status === 'pending' || !token}
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 px-4 py-2 text-sm font-semibold"
            >
              {status === 'pending' ? 'Waiting for passkey…' : 'Create passkey'}
            </button>
            {error ? <div className="text-xs text-red-300 break-words">{error}</div> : null}
          </>
        ) : null}

        {status === 'done' && secrets ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-900/60 bg-emerald-950/30 p-3 text-sm text-emerald-300">
              Passkey registered. Save these values NOW — they will not be shown again.
            </div>
            <SecretRow label="ADMIN_PASSKEY_CREDENTIAL_ID" value={secrets.credentialId} />
            <SecretRow label="ADMIN_PASSKEY_PUBLIC_KEY" value={secrets.publicKey} />
            <div className="pt-2 text-xs text-neutral-400 space-y-2">
              <p>Add these as GitHub Actions secrets, then remove the bootstrap token:</p>
              <pre className="rounded-md bg-neutral-950 border border-neutral-800 p-3 text-neutral-300 overflow-x-auto">
                {`gh secret set ADMIN_PASSKEY_CREDENTIAL_ID --body "${secrets.credentialId}"
gh secret set ADMIN_PASSKEY_PUBLIC_KEY --body "${secrets.publicKey}"
gh secret delete ADMIN_BOOTSTRAP_TOKEN
gh workflow run deploy-fly.yaml -f services=admin`}
              </pre>
              <p>
                Once the next deploy completes, <code>/auth/bootstrap</code> will 404 and
                <code> /auth/login</code> will accept this passkey.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">{label}</div>
      <input
        readOnly
        onClick={(e) => e.currentTarget.select()}
        value={value}
        className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs font-mono text-neutral-100"
      />
    </div>
  );
}
