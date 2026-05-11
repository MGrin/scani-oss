import { safeRedirectPath } from '@scani/shared';
import { NextResponse } from 'next/server';
import { beginPasskeyLogin } from '@/lib/auth/passkey';
import { signChallenge } from '@/lib/auth/session';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// /auth/login is a *route handler*, not a page. We serve plain HTML so
// React/Next.js never hydrate this URL — earlier attempts (#473..#477)
// kept failing on iOS Brave because React 18's hydration reconciles the
// entire <body>, and any DOM mutation our auth script made before
// hydration (attaching listeners, flipping a status line, setting
// data-script-loaded) caused React to detach and re-create the button
// subtree, taking our event listeners with it. Document-level capture
// listeners survived hydration; button-level ones didn't — which
// matches the symptom exactly. Removing the page component removes
// hydration from this path entirely.
//
// /auth/login/script and /auth/login/complete remain as route handlers.
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const next = safeRedirectPath(url.searchParams.get('next'), '/');
  const options = await beginPasskeyLogin();
  const challengeToken = await signChallenge(options.challenge);

  const optionsAttr = htmlAttr(JSON.stringify(options));
  const tokenAttr = htmlAttr(challengeToken);
  const nextAttr = htmlAttr(next);

  // Inline dark-theme HSL values mirror the @scani/ui design tokens in
  // `packages/frontend/ui/src/styles/globals.css` (see the `.dark`
  // block). Inlining them here keeps the login page self-contained — it
  // doesn't depend on the Next.js stylesheet hash, which changes per
  // build. Login is always dark; the authed shell handles light/dark
  // switching via ThemeProvider once the user is in.
  const html = `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>scani · admin · sign in</title>
<style>
:root{
  --background:0 0% 3.9%;
  --foreground:0 0% 98%;
  --card:0 0% 3.9%;
  --muted:0 0% 14.9%;
  --muted-foreground:0 0% 63.9%;
  --primary:0 0% 98%;
  --primary-foreground:0 0% 9%;
  --border:0 0% 14.9%;
  --destructive:0 62.8% 30.6%;
  --destructive-foreground:0 0% 98%;
  --radius:.5rem;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{
  background:hsl(var(--background));
  color:hsl(var(--foreground));
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  -webkit-font-smoothing:antialiased;
}
.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{
  width:100%;max-width:24rem;
  border:1px solid hsl(var(--border));
  background:hsl(var(--card));
  border-radius:var(--radius);
  padding:1.5rem;
  box-shadow:0 1px 2px 0 rgb(0 0 0 / 0.05);
}
.brand{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.25rem}
h1{font-size:1rem;font-weight:600;letter-spacing:-0.01em}
.brand-tag{font-size:.625rem;text-transform:uppercase;letter-spacing:.05em;color:hsl(var(--muted-foreground))}
.lead{font-size:.75rem;color:hsl(var(--muted-foreground));margin-bottom:1.5rem;line-height:1.5}
button{
  display:block;width:100%;
  border:1px solid hsl(var(--border));
  background:hsl(var(--primary));
  color:hsl(var(--primary-foreground));
  padding:.625rem 1rem;
  font-size:.875rem;font-weight:600;
  border-radius:calc(var(--radius) - 2px);
  font-family:inherit;
  cursor:pointer;
  min-height:2.5rem;
  touch-action:manipulation;
  -webkit-tap-highlight-color:transparent;
  transition:opacity .15s ease,background-color .15s ease;
}
button:hover{opacity:.92}
button:active{opacity:.85}
button:disabled{opacity:.5;cursor:default}
#signin-error{
  margin-top:1rem;
  font-size:.75rem;
  color:hsl(var(--destructive-foreground));
  background:hsl(var(--destructive) / 0.15);
  border:1px solid hsl(var(--destructive) / 0.4);
  border-radius:calc(var(--radius) - 2px);
  padding:.5rem .625rem;
  word-break:break-word;
  display:none;
}
#signin-error:not(:empty){display:block}
#signin-status{
  margin-top:.75rem;display:block;
  font-size:.625rem;
  color:hsl(var(--muted-foreground) / 0.7);
}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="brand">
      <h1>scani · admin</h1>
      <span class="brand-tag">sign in</span>
    </div>
    <p class="lead">Sign in with your passkey to access the operator dashboard.</p>
    <button id="signin-button" type="button" data-options="${optionsAttr}" data-token="${tokenAttr}" data-next="${nextAttr}">Sign in with passkey</button>
    <div id="signin-error"></div>
    <small id="signin-status">Initializing…</small>
    <script src="/auth/login/script" defer></script>
  </div>
</div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
    },
  });
}

function htmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
