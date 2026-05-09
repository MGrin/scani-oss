import { ThemeToggle } from '@scani/ui';
import { Sheet, SheetContent } from '@scani/ui/ui/sheet';
import { BarChart3, KeyRound, LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
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

/**
 * Authenticated layout: persistent sidebar on desktop, hamburger + left
 * drawer on mobile. Visual parity with frontendV2 is preserved via the
 * shared Tailwind preset + globals.css.
 */
export function Shell() {
  const { data } = authClient.useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeMobile = () => setMobileOpen(false);

  const handleSignOut = async () => {
    await authClient.signOut();
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
      <aside className="hidden w-60 flex-col border-r bg-card lg:flex">{sidebarBody}</aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          {sidebarBody}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-2 border-b border-border bg-card px-3 lg:hidden"
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
          <Link to="/keys" className="text-sm font-semibold">
            Scani Cloud
          </Link>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
