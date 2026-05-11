import { NextResponse } from 'next/server';
import { beginPasskeyLogin } from '@/lib/auth/passkey';
import { CHALLENGE_COOKIE, challengeCookieOpts, signChallenge } from '@/lib/auth/session';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Plain GET endpoint that returns fresh WebAuthn authentication options and
// sets the signed-challenge cookie. The login page calls this from a `fetch`
// in `useEffect` so the click handler can later invoke `startAuthentication`
// synchronously — preserving the user-gesture activation that mobile browsers
// (iOS Safari especially) require for `navigator.credentials.get()`.
//
// Implemented as a route handler rather than a Server Action because Server
// Actions invoked from `useEffect` on Cloudflare Pages (`@cloudflare/next-on-pages`)
// have been observed to hang silently — the action POST never resolves on the
// client, leaving the page stuck in "Preparing…".
export async function GET(): Promise<NextResponse> {
  const options = await beginPasskeyLogin();
  const token = await signChallenge(options.challenge);
  const res = NextResponse.json(options);
  res.cookies.set(CHALLENGE_COOKIE, token, challengeCookieOpts());
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
