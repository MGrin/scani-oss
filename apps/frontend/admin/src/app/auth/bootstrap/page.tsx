'use client';

import { Alert, AlertDescription } from '@scani/ui/ui/alert';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { startRegistration } from '@simplewebauthn/browser';
import { CheckCircle2 } from 'lucide-react';
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
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-lg">scani · admin bootstrap</CardTitle>
          <CardDescription>
            One-shot passkey registration. Displays the secrets once; copy them into GitHub Actions
            / Cloudflare Pages secrets, then remove{' '}
            <code className="font-mono">ADMIN_BOOTSTRAP_TOKEN</code> to permanently lock this route.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {status !== 'done' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="bootstrap-token">Bootstrap token</Label>
                <Input
                  id="bootstrap-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={status === 'pending'}
                />
              </div>
              <Button
                type="button"
                onClick={onRegister}
                disabled={status === 'pending' || !token}
                className="w-full"
              >
                {status === 'pending' ? 'Waiting for passkey…' : 'Create passkey'}
              </Button>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription className="break-words font-mono text-xs">
                    {error}
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}

          {status === 'done' && secrets ? (
            <div className="space-y-4">
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>
                  Passkey registered. Save these values NOW — they will not be shown again.
                </AlertDescription>
              </Alert>
              <SecretRow label="ADMIN_PASSKEY_CREDENTIAL_ID" value={secrets.credentialId} />
              <SecretRow label="ADMIN_PASSKEY_PUBLIC_KEY" value={secrets.publicKey} />
              <div className="space-y-2 pt-2 text-xs text-muted-foreground">
                <p>Add these as GitHub Actions secrets, then remove the bootstrap token:</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-foreground/80">
                  {`gh secret set ADMIN_PASSKEY_CREDENTIAL_ID --body "${secrets.credentialId}"
gh secret set ADMIN_PASSKEY_PUBLIC_KEY --body "${secrets.publicKey}"
gh secret delete ADMIN_BOOTSTRAP_TOKEN
gh workflow run deploy-fly.yaml -f services=admin`}
                </pre>
                <p>
                  Once the next deploy completes, <code className="font-mono">/auth/bootstrap</code>{' '}
                  will 404 and <code className="font-mono">/auth/login</code> will accept this
                  passkey.
                </p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      <Input
        readOnly
        onClick={(e) => e.currentTarget.select()}
        value={value}
        className="font-mono text-xs"
      />
    </div>
  );
}
