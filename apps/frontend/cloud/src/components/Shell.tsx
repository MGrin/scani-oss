import { InstallPromptBanner, ThemeToggle } from '@scani/ui';
import { PullToRefresh } from '@scani/ui/components/PullToRefresh';
import { Sheet, SheetContent } from '@scani/ui/ui/sheet';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, BookOpen, ExternalLink, KeyRound, LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

interface NavItemDef {
  to: string;
  label: string;
  Icon: typeof KeyRound;
}

const NAV_ITEMS: NavItemDef[] = [
  { to: '/keys', label: 'API keys', Icon: KeyRound },
  { to: '/usage', label: 'Usage', Icon: BarChart3 },
];

// Data-provider hosts /docs (Scalar UI). In prod VITE_DATA_PROVIDER_URL
// resolves to https://api.cloud.scani.xyz so the link is cross-origin
// and opens in a new tab; in dev we leave it relative and Vite's
// dev-server proxies /docs to the local data-provider (see vite.config.ts).
const API_DOCS_HREF = `${import.meta.env.VITE_DATA_PROVIDER_URL ?? ''}/docs`;

function getPageTitle(pathname: string): string {
  for (const item of NAV_ITEMS) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) return item.label;
  }
  return 'Scani Cloud';
}

/**
 * Authenticated layout: persistent sidebar on desktop, hamburger + left
 * drawer on mobile. Visual parity with frontendV2 is preserved via the
 * shared Tailwind preset + globals.css.
 */
export function Shell() {
  const { data } = authClient.useSession();
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const queryClient = useQueryClient();

  const closeMobile = () => setMobileOpen(false);
  const title = getPageTitle(pathname);

  const handleRefresh = async () => {
    await queryClient.invalidateQueries();
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.href = '/auth';
  };

  const sidebarBody = (
    <div className="flex h-full flex-col">
      <div
        className="px-5"
        style={{
          paddingTop: 'calc(1.5rem + env(safe-area-inset-top))',
          paddingBottom: '1.5rem',
        }}
      >
        <div className="text-base font-semibold">Scani Cloud</div>
        <div className="text-xs text-muted-foreground">API console</div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={closeMobile}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
        <a
          href={API_DOCS_HREF}
          target="_blank"
          rel="noreferrer noopener"
          onClick={closeMobile}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <BookOpen className="h-4 w-4" />
          <span className="flex-1">API docs</span>
          <ExternalLink className="h-3.5 w-3.5 opacity-60" />
        </a>
      </nav>
      <div
        className="border-t px-3 py-3 space-y-px"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mb-1 truncate px-2 text-xs text-muted-foreground">{data?.user?.email}</div>
        <ThemeToggle variant="row" side="top" align="start" />
        <button
          type="button"
          onClick={handleSignOut}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-red-600 transition-colors hover:bg-red-600/10"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className="truncate">Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <InstallPromptBanner isLoggedIn={!!data?.user} appName="Scani Cloud" />
      <aside className="hidden w-60 flex-col border-r bg-card lg:flex">{sidebarBody}</aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          {sidebarBody}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar — shows the active page title; the desktop
            sidebar already shows the brand. */}
        <header
          className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 lg:hidden"
          style={{
            paddingTop: 'env(safe-area-inset-top)',
            minHeight: 'calc(3.5rem + env(safe-area-inset-top))',
          }}
        >
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="flex-1 truncate text-sm font-medium text-foreground">{title}</h1>
        </header>

        <main className="min-h-0 flex-1">
          <PullToRefresh onRefresh={handleRefresh}>
            <Outlet />
            {/* Spacer so the bottom MobileNav doesn't overlap the last
                row of content. Mirrors apps/frontend/app/src/v2/layouts/AppShell.tsx. */}
            <div
              aria-hidden="true"
              className="lg:hidden"
              style={{ height: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' }}
            />
          </PullToRefresh>
        </main>
      </div>

      {/* Mobile bottom nav — only two internal routes plus "More" for
          the rest (sign-out, theme toggle, API docs link). Fixed to the
          viewport so PWA scroll anchoring doesn't drift it. */}
      <nav
        aria-label="Primary"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 flex items-center justify-around border-t border-border bg-background"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          height: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={label}
            className={({ isActive }) =>
              `flex h-full flex-1 flex-col items-center justify-center gap-0.5 text-[10px] ${
                isActive ? 'text-primary' : 'text-muted-foreground'
              }`
            }
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="More"
          className="flex h-full flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
