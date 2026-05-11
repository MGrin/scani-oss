import { type NextRequest, NextResponse } from 'next/server';
import { bootstrapStatus, devBypassEnabled } from '@/lib/auth/config';
import { SESSION_COOKIE, sessionCookieOpts, signSession, verifySession } from '@/lib/auth/session';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|auth).*)'],
};

export async function middleware(req: NextRequest) {
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
