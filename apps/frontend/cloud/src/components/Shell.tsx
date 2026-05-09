import { ThemeToggle } from '@scani/ui';
import { BarChart3, KeyRound, LogOut } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

/**
 * Authenticated layout: left sidebar + outlet for the page content.
 *
 * Visual parity with frontendV2 is preserved via the shared Tailwind
 * preset + globals.css — colors, radii and typography are all identical.
 */
export function Shell() {
  const location = useLocation();
  const { data } = authClient.useSession();

  const navItem = (to: string, label: string, Icon: typeof KeyRound) => {
    const active = location.pathname.startsWith(to);
    return (
      <Link
        to={to}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        }`}
      >
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    );
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-60 flex-col border-r bg-card">
        <div className="px-5 py-6">
          <div className="text-base font-semibold">Scani Cloud</div>
          <div className="text-xs text-muted-foreground">API console</div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {navItem('/keys', 'API keys', KeyRound)}
          {navItem('/usage', 'Usage', BarChart3)}
        </nav>
        <div className="border-t px-3 py-3 space-y-px">
          <div className="mb-1 truncate px-2 text-xs text-muted-foreground">
            {data?.user?.email}
          </div>
          <ThemeToggle variant="row" side="top" align="start" />
          <button
            type="button"
            onClick={async () => {
              await authClient.signOut();
              window.location.href = '/auth';
            }}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-red-600 hover:bg-red-600/10 transition-colors w-full"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span className="truncate">Sign out</span>
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
