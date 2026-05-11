import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { NextResponse } from 'next/server';
import { verifyPasskeyLogin } from '@/lib/auth/passkey';
import {
  SESSION_COOKIE,
  sessionCookieOpts,
  signSession,
  verifyChallenge,
} from '@/lib/auth/session';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface CompleteBody {
  response: AuthenticationResponseJSON;
  token: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: CompleteBody;
  try {
    body = (await req.json()) as CompleteBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!body.token) {
    return NextResponse.json({ ok: false, error: 'Missing challenge token' }, { status: 400 });
  }

  const challenge = await verifyChallenge(body.token);
  if (!challenge) {
    return NextResponse.json({ ok: false, error: 'Challenge expired or invalid' });
  }

  let verified = false;
  try {
    verified = await verifyPasskeyLogin(body.response, challenge.challenge);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Verification failed',
    });
  }

  if (!verified) {
    return NextResponse.json({ ok: false, error: 'Passkey verification failed' });
  }

  const session = await signSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, session, sessionCookieOpts());
  return res;
}
