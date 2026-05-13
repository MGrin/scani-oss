'use client';

import { ThemeToggle } from '@scani/ui/components/ThemeToggle';
import { cn } from '@scani/ui/lib/cn';
import { Button } from '@scani/ui/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@scani/ui/ui/sheet';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cloud,
  Database,
  DollarSign,
  Gauge,
  GitBranch,
  History,
  ListChecks,
  LogOut,
  Mail,
  Menu,
  Plug,
  Server,
  Users,
  Wallet,
  Waves,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType, ReactNode } from 'react';
import { useState } from 'react';

type IconType = ComponentType<{ className?: string }>;

interface NavLink {
  href: string;
  label: string;
  icon: IconType;
  /** Match the active state on any path that starts with this prefix (default: exact match). */
  matchPrefix?: boolean;
}

interface NavGroup {
  label: string;
  items: NavLink[];
}

// Information architecture as defined in the rewrite plan. Pages that
// don't exist yet (providers, jobs/schedules, app/*, spend) are still
// listed so the shell is complete on day one — they'll 404 until Phase 2
// fills them in, but the nav surface is stable.
const NAV: NavGroup[] = [
  {
    label: 'Dashboard',
    items: [{ href: '/', label: 'Overview', icon: Gauge }],
  },
  {
    label: 'Platform',
    items: [
      { href: '/platform/fly', label: 'Fly', icon: Server, matchPrefix: true },
      { href: '/platform/neon', label: 'Neon', icon: Database, matchPrefix: true },
      { href: '/platform/upstash', label: 'Upstash', icon: Waves, matchPrefix: true },
      { href: '/platform/cloudflare', label: 'Cloudflare', icon: Cloud, matchPrefix: true },
      { href: '/platform/github', label: 'GitHub', icon: GitBranch, matchPrefix: true },
      { href: '/platform/sentry', label: 'Sentry', icon: AlertTriangle, matchPrefix: true },
      { href: '/platform/fastmail', label: 'Fastmail', icon: Mail, matchPrefix: true },
    ],
  },
  {
    label: 'Integrations',
    items: [{ href: '/providers', label: 'Providers', icon: Plug, matchPrefix: true }],
  },
  {
    label: 'Jobs',
    items: [
      { href: '/jobs/queue', label: 'Queue', icon: Activity, matchPrefix: true },
      { href: '/jobs/schedules', label: 'Schedules', icon: ListChecks, matchPrefix: true },
      { href: '/jobs/dlq', label: 'DLQ', icon: AlertTriangle, matchPrefix: true },
      { href: '/jobs/user-jobs', label: 'User jobs', icon: ListChecks, matchPrefix: true },
    ],
  },
  {
    label: 'App data',
    items: [
      { href: '/app/users', label: 'Users', icon: Users, matchPrefix: true },
      { href: '/app/waitlist', label: 'Waitlist', icon: Users, matchPrefix: true },
      { href: '/app/holdings', label: 'Holdings', icon: Wallet, matchPrefix: true },
      { href: '/app/integrations', label: 'Integrations', icon: Plug, matchPrefix: true },
      { href: '/app/cloud', label: 'Cloud', icon: BarChart3, matchPrefix: true },
    ],
  },
  {
    label: 'Billing',
    items: [{ href: '/spend', label: 'Spend', icon: DollarSign, matchPrefix: true }],
  },
  {
    label: 'Operations',
    items: [{ href: '/audit-log', label: 'Audit log', icon: History, matchPrefix: true }],
  },
];

function isActive(pathname: string, item: NavLink): boolean {
  if (item.matchPrefix) return pathname === item.href || pathname.startsWith(`${item.href}/`);
  return pathname === item.href;
}

function NavList({
  pathname,
  onNavigate,
  className,
}: {
  pathname: string;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <nav className={cn('flex flex-col gap-5 text-sm', className)} aria-label="Admin">
      {NAV.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {group.label}
          </div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                )}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function SignOutForm({ className }: { className?: string }) {
  // Form POST keeps the session-cookie deletion CSRF-safe and removes
  // any reliance on JS. The /auth/logout route handler accepts both GET
  // and POST so legacy links still work.
  return (
    <form action="/auth/logout" method="post" className={className}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </Button>
    </form>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '/';
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Top bar — mobile + desktop */}
      <header
        className="flex items-center justify-between gap-2 border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden"
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          minHeight: 'calc(3.5rem + env(safe-area-inset-top, 0px))',
        }}
      >
        <div className="flex items-center gap-3">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Open navigation">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="flex w-72 flex-col gap-4 overflow-y-auto p-4"
              style={{
                paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))',
                paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <Link
                href="/"
                onClick={() => setOpen(false)}
                className="text-base font-semibold tracking-tight"
              >
                scani · admin
              </Link>
              <NavList pathname={pathname} onNavigate={() => setOpen(false)} />
              <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
                <ThemeToggle variant="row" side="top" align="start" />
                <SignOutForm />
              </div>
            </SheetContent>
          </Sheet>
          <Link href="/" className="text-base font-semibold tracking-tight">
            scani · admin
          </Link>
        </div>
        <ThemeToggle variant="icon" side="bottom" align="end" />
      </header>

      {/* Desktop sidebar */}
      <aside
        className="hidden w-60 shrink-0 flex-col gap-5 border-r border-border bg-background/50 px-4 lg:flex"
        style={{
          paddingTop: 'calc(1.25rem + env(safe-area-inset-top, 0px))',
          paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <Link href="/" className="px-2 text-base font-semibold tracking-tight">
          scani · admin
        </Link>
        <NavList pathname={pathname} className="flex-1" />
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <ThemeToggle variant="row" side="top" align="start" />
          <SignOutForm />
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div
          className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8"
          style={{
            // On desktop the mobile header is hidden, so the main content
            // is what sits flush with the top of the viewport. Push it
            // past the notch when running as an installed PWA on a device
            // with a status bar. Mobile already gets safe-area from the
            // sticky header above.
            paddingTop: 'max(1.5rem, env(safe-area-inset-top, 0px))',
            paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom, 0px))',
          }}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
