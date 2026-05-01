import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL('/auth/login', req.url));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export async function GET(req: Request) {
  return POST(req);
}
