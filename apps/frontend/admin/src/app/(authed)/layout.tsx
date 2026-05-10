import Link from 'next/link';
import type { ReactNode } from 'react';

// Header + service nav live here so /auth/* pages (bootstrap, login) don't
// expose the list of services the dashboard monitors to unauthenticated
// visitors. Middleware enforces that only authenticated requests reach this
// layout, so anything rendered below is behind the passkey gate.

const nav: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Overview' },
  { href: '/services/fly', label: 'Fly' },
  { href: '/services/neon', label: 'Neon' },
  { href: '/services/upstash', label: 'Upstash' },
  { href: '/services/bullmq', label: 'BullMQ' },
  { href: '/services/cloudflare', label: 'Cloudflare' },
  { href: '/services/github', label: 'GitHub' },
  { href: '/services/fastmail', label: 'Fastmail' },
  { href: '/services/sentry', label: 'Sentry' },
  { href: '/app-stats', label: 'App stats' },
];

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            scani · admin
          </Link>
          <a href="/auth/logout" className="text-xs text-muted-foreground hover:text-foreground/80">
            sign out
          </a>
        </div>
        <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-foreground hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="px-6 py-8">{children}</main>
    </>
  );
}
