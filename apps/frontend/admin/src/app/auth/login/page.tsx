import { safeRedirectPath } from '@scani/shared';
import { beginPasskeyLogin } from '@/lib/auth/passkey';
import { signChallenge } from '@/lib/auth/session';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { next?: string };
}

// Plain HTML page — no Client Component, no Server Action, no RSC
// hydration on the critical path. The click handler is wired up by
// /auth/login/script (a vanilla JS file served by a route handler) so
// the signin flow works even if React's reconciler bails on the page
// (which is what we observed on iOS Brave after #473).
export default async function LoginPage({ searchParams }: PageProps) {
  // Validated against open-redirect chains: any non-same-origin target
  // (`https://…`, `//…`, `javascript:…`) falls back to `/`.
  const next = safeRedirectPath(searchParams.next, '/');
  const options = await beginPasskeyLogin();
  const challengeToken = await signChallenge(options.challenge);
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card/40 p-6">
        <h1 className="text-lg font-semibold mb-1">scani · admin</h1>
        <p className="text-xs text-muted-foreground mb-6">
          Sign in with your passkey to access the dashboard.
        </p>
        <button
          id="signin-button"
          type="button"
          data-options={JSON.stringify(options)}
          data-token={challengeToken}
          data-next={next}
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'rgba(255,255,255,0.1)' }}
          className="w-full cursor-pointer rounded-md border border-border bg-muted hover:bg-muted active:bg-muted/70 disabled:opacity-50 px-4 py-2 text-sm font-semibold"
        >
          Sign in with passkey
        </button>
        <div id="signin-error" className="mt-4 text-xs text-red-300 break-words" />
        {/* `signin-status` starts as "Initializing…"; the inline JS flips it
            to "Ready" as soon as it attaches the click listener. If you see
            the button next to a stuck "Initializing…", the script never
            loaded — that's the failure to diagnose, not the click itself. */}
        <small id="signin-status" className="mt-2 block text-[10px] text-muted-foreground/60">
          Initializing…
        </small>
        <script src="/auth/login/script" defer />
      </div>
    </div>
  );
}
