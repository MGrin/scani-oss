import { NextResponse } from 'next/server';
import { getBackendHealth } from '@/lib/clients/backendHealth';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET() {
  const res = await getBackendHealth();
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 502 });
  return NextResponse.json(res.data, { status: res.data.statusCode });
}
