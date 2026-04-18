import type { ReactNode } from 'react';

// Server component so the route-segment config below actually applies.
// Without this, /auth/bootstrap gets pre-rendered into static HTML at
// build time — and POSTs to the Edge Function (for server actions) 405.
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function BootstrapLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
