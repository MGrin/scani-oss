import { safeRedirectPath } from '@scani/shared';
import type { ReactNode } from 'react';
import { beginPasskeyLogin } from '@/lib/auth/passkey';
import { signChallenge } from '@/lib/auth/session';
import { LoginForm } from './LoginForm';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { next?: string };
}

export default async function LoginPage({ searchParams }: PageProps) {
  // Validated against open-redirect chains: any non-same-origin target
  // (`https://…`, `//…`, `javascript:…`) falls back to `/`.
  const next = safeRedirectPath(searchParams.next, '/');
  // Mint a fresh challenge inline. The signed token travels to the client
  // as a prop and back to `completeLoginAction` as an argument — no
  // challenge cookie is involved, so concurrent page renders (browser
  // prefetch, RSC payload fetch, etc.) can't desync the challenge the
  // user signed over from the one the server verifies against.
  const options = await beginPasskeyLogin();
  const challengeToken = await signChallenge(options.challenge);
  return (
    <LoginShell>
      <LoginForm options={options} challengeToken={challengeToken} next={next} />
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
