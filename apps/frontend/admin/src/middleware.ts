import { type NextRequest, NextResponse } from 'next/server';
import { bootstrapStatus, devBypassEnabled } from '@/lib/auth/config';
import { LOGIN_OPTIONS_HEADER } from '@/lib/auth/login-headers';
import { beginPasskeyLogin } from '@/lib/auth/passkey';
import {
  CHALLENGE_COOKIE,
  challengeCookieOpts,
  SESSION_COOKIE,
  sessionCookieOpts,
  signChallenge,
  signSession,
  verifySession,
} from '@/lib/auth/session';

export const config = {
  matcher: [
    // All non-auth, non-static paths run through the session check below.
    '/((?!_next/static|_next/image|favicon.ico|auth).*)',
    // /auth/login is matched separately so middleware can mint a fresh
    // WebAuthn challenge cookie and forward the generated options to the
    // page as a request header. SSR'ing the challenge avoids any
    // client-side fetch on mobile WebViews (iOS Brave / Safari) which we
    // observed silently hanging — leaving the login button stuck on
    // "Preparing…".
    '/auth/login',
  ],
};

async function prepareLoginChallenge(req: NextRequest): Promise<NextResponse> {
  const options = await beginPasskeyLogin();
  const token = await signChallenge(options.challenge);
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set(LOGIN_OPTIONS_HEADER, JSON.stringify(options));
  const res = NextResponse.next({ request: { headers: reqHeaders } });
  res.cookies.set(CHALLENGE_COOKIE, token, challengeCookieOpts());
  return res;
}

export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/auth/login') {
    if (devBypassEnabled()) return NextResponse.next();
    const bootstrap = bootstrapStatus();
    if (bootstrap.enabled) {
      return NextResponse.redirect(new URL('/auth/bootstrap', req.url));
    }
    if (!bootstrap.passkeyProvisioned) {
      return new NextResponse('Admin passkey is not provisioned.', { status: 503 });
    }
    return prepareLoginChallenge(req);
  }

  if (devBypassEnabled()) return NextResponse.next();

  const bootstrap = bootstrapStatus();

  if (bootstrap.enabled) {
    // No passkey yet — send the operator to the one-shot registration flow.
    return NextResponse.redirect(new URL('/auth/bootstrap', req.url));
  }

  if (!bootstrap.passkeyProvisioned) {
    // No passkey AND no bootstrap token: locked out entirely.
    return new NextResponse('Admin passkey is not provisioned.', { status: 503 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    const url = new URL('/auth/login', req.url);
    if (req.nextUrl.pathname !== '/') url.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  const refreshed = await signSession();
  res.cookies.set(SESSION_COOKIE, refreshed, sessionCookieOpts());
  return res;
}
