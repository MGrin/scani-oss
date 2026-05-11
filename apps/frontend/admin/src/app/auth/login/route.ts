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

  const html = `<!DOCTYPE html>
<html lang="en" class="dark" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>scani · admin</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{background:#09090b;color:#fafafa;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-font-smoothing:antialiased}
.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{width:100%;max-width:24rem;border:1px solid #27272a;background:rgba(255,255,255,0.02);border-radius:.5rem;padding:1.5rem}
h1{font-size:1.125rem;font-weight:600;margin-bottom:.25rem}
.lead{font-size:.75rem;color:rgba(250,250,250,0.5);margin-bottom:1.5rem}
button{display:block;width:100%;border:1px solid #27272a;background:rgba(255,255,255,0.1);padding:.5rem 1rem;font-size:.875rem;font-weight:600;border-radius:.375rem;color:inherit;font-family:inherit;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(255,255,255,0.1)}
button:active{background:rgba(255,255,255,0.05)}
button:disabled{opacity:.5;cursor:default}
#signin-error{margin-top:1rem;font-size:.75rem;color:#fca5a5;word-break:break-word;min-height:1em}
#signin-status{margin-top:.5rem;display:block;font-size:.625rem;color:rgba(250,250,250,0.3)}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>scani · admin</h1>
    <p class="lead">Sign in with your passkey to access the dashboard.</p>
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
