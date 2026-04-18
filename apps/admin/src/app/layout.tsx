import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scani Admin',
  description: 'Infrastructure & usage overview',
};

const nav: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Overview' },
  { href: '/services/fly', label: 'Fly' },
  { href: '/services/neon', label: 'Neon' },
  { href: '/services/upstash', label: 'Upstash' },
  { href: '/services/cloudflare', label: 'Cloudflare' },
  { href: '/services/github', label: 'GitHub' },
  { href: '/services/fastmail', label: 'Fastmail' },
  { href: '/app-stats', label: 'App stats' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-neutral-800 px-6 py-4">
            <div className="flex items-center justify-between">
              <Link href="/" className="text-lg font-semibold tracking-tight">
                scani · admin
              </Link>
              <a href="/auth/logout" className="text-xs text-neutral-500 hover:text-neutral-300">
                sign out
              </a>
            </div>
            <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-neutral-400 hover:text-neutral-100"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
