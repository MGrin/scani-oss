import { PullToRefresh } from '@scani/ui/components/PullToRefresh';
import { Sheet, SheetContent } from '@scani/ui/ui/sheet';
import {
  Building2,
  Coins,
  FileUp,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  LogOut,
  type LucideIcon,
  PieChart,
  Plug,
  Settings,
  Tags,
  Vault,
  Wallet,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { CommandPalette } from '../components/command-palette/CommandPalette';
import { useSidebarState } from '../hooks/useSidebarState';
import { useUserJobs } from '../hooks/useUserJobs';
import { NAV_SECTIONS, V2_ROUTES } from '../lib/routes';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  PieChart,
  Wallet,
  Building2,
  Tags,
  Vault,
  Plug,
  FileUp,
  Keyboard,
  Coins,
  ListChecks,
};

export function AppShell() {
  const { collapsed, toggle, mobileOpen, setMobileOpen } = useSidebarState();
  const [commandOpen, setCommandOpen] = useState(false);
  const utils = trpc.useUtils();
  const { signOut } = useAuth();
  const { actionRequiredCount } = useUserJobs();
  const jobsNavRef = useRef<HTMLAnchorElement>(null);

  // When the mobile sidebar opens and there are jobs needing attention,
  // scroll the Jobs nav item into view — on short viewports it can sit
  // below the fold.
  useEffect(() => {
    if (!mobileOpen || actionRequiredCount === 0) return;
    const id = window.setTimeout(() => {
      jobsNavRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 150);
    return () => window.clearTimeout(id);
  }, [mobileOpen, actionRequiredCount]);

  const handleRefresh = async () => {
    await utils.invalidate();
  };

  const handleSignOut = () => {
    setMobileOpen(false);
    void signOut();
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <Sidebar collapsed={collapsed} onToggle={toggle} />

      {/* Mobile sidebar sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <div className="flex flex-col h-full">
            <div
              className="flex items-center px-4 border-b border-border shrink-0"
              style={{
                paddingTop: 'env(safe-area-inset-top)',
                minHeight: 'calc(3.5rem + env(safe-area-inset-top))',
              }}
            >
              <span className="text-lg font-semibold tracking-tight">Scani</span>
            </div>
            <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-4">
              {NAV_SECTIONS.map((section) => (
                <div key={section.title}>
                  <p className="px-2 mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {section.title}
                  </p>
                  <div className="space-y-0.5">
                    {section.items.map((item) => {
                      const Icon = ICON_MAP[item.icon] || PieChart;
                      const badgeCount =
                        item.path === V2_ROUTES.jobs && actionRequiredCount > 0
                          ? actionRequiredCount
                          : undefined;
                      const isJobs = item.path === V2_ROUTES.jobs;
                      return (
                        <NavLink
                          key={item.path}
                          to={item.path}
                          ref={isJobs ? jobsNavRef : undefined}
                          end={item.path === V2_ROUTES.dashboard}
                          onClick={() => setMobileOpen(false)}
                          className={({ isActive }) =>
                            cn(
                              'flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
                              isActive
                                ? 'bg-accent text-accent-foreground font-medium'
                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                            )
                          }
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span>{item.label}</span>
                          {badgeCount && (
                            <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                              {badgeCount}
                            </span>
                          )}
                        </NavLink>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
            <div
              className="border-t border-border p-2 space-y-0.5"
              style={{ paddingBottom: 'env(safe-area-inset-bottom, 0.5rem)' }}
            >
              <NavLink
                to={V2_ROUTES.settings}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )
                }
              >
                <Settings className="h-4 w-4 shrink-0" />
                <span>Settings</span>
              </NavLink>
              <button
                type="button"
                onClick={handleSignOut}
                className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-red-600 hover:bg-red-600/10 transition-colors w-full"
              >
                <LogOut className="h-4 w-4 shrink-0" />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          onMobileMenuOpen={() => setMobileOpen(true)}
          onCommandPaletteOpen={() => setCommandOpen(true)}
          actionRequiredCount={actionRequiredCount}
        />
        <div className="flex-1 min-h-0">
          <PullToRefresh onRefresh={handleRefresh}>
            <main data-scrollable="true">
              <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-4 sm:pt-6 pb-4 sm:pb-6">
                <Outlet />
              </div>
              {/* Spacer for fixed MobileNav on mobile - matches its height + safe-area inset */}
              <div
                aria-hidden="true"
                className="lg:hidden"
                style={{ height: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))' }}
              />
            </main>
          </PullToRefresh>
        </div>
        {/* Mobile bottom nav - fixed to the viewport so it never drifts with dvh shifts (keyboard focus/blur, PWA scroll anchoring) */}
        <MobileNav
          onMorePress={() => setMobileOpen(true)}
          actionRequiredCount={actionRequiredCount}
        />
      </div>

      {/* Command palette */}
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
