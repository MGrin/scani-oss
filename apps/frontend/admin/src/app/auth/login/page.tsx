import { safeRedirectPath } from '@scani/shared';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { LOGIN_OPTIONS_HEADER } from '@/lib/auth/login-headers';
import { LoginForm } from './LoginForm';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { next?: string };
}

export default function LoginPage({ searchParams }: PageProps) {
  // Validated against open-redirect chains: any non-same-origin target
  // (`https://…`, `//…`, `javascript:…`) falls back to `/`.
  const next = safeRedirectPath(searchParams.next, '/');
  // Options are minted by middleware on every GET /auth/login so the
  // signed-challenge cookie and the inline `optionsJSON` are guaranteed
  // to match. No client fetch is required before the user clicks the
  // passkey button — that's what lets iOS Safari / Brave preserve the
  // gesture activation `navigator.credentials.get()` needs.
  const raw = headers().get(LOGIN_OPTIONS_HEADER);
  if (!raw) {
    return (
      <LoginShell>
        <p className="text-xs text-red-300">
          Failed to prepare passkey challenge. Refresh the page to try again.
        </p>
      </LoginShell>
    );
  }
  const options = JSON.parse(raw) as PublicKeyCredentialRequestOptionsJSON;
  return (
    <LoginShell>
      <LoginForm initialOptions={options} next={next} />
    </LoginShell>
  );
}

function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card/40 p-6">
        <h1 className="text-lg font-semibold mb-1">scani · admin</h1>
        <p className="text-xs text-muted-foreground mb-6">
          Sign in with your passkey to access the dashboard.
        </p>
        {children}
      </div>
    </div>
  );
}
