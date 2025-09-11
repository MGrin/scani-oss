import {
  Building2,
  CreditCard,
  Home,
  LogOut,
  Menu,
  PieChart,
  Settings,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { SkipLinks } from '@/components/ui/skip-links';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useAuth } from '@/contexts/AuthContext';
import { useSessionTimeoutContext } from '@/hooks/useSessionTimeout';
import { MOBILE_SPACING } from '@/lib/mobile-utils';
import { cn } from '@/lib/utils';

interface LayoutProps {
  children: React.ReactNode;
}

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Institutions', href: '/institutions', icon: Building2 },
  { name: 'Accounts', href: '/accounts', icon: Wallet },
  { name: 'Holdings', href: '/holdings', icon: PieChart },
  { name: 'Transactions', href: '/transactions', icon: CreditCard },

  { name: 'Analytics', href: '/analytics', icon: TrendingUp },
];

export function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const { isActive, showWarning } = useSessionTimeoutContext();
  const { signOut, user } = useAuth();
  const navigationId = useId();
  const mainContentId = useId();

  const handleSignOut = async () => {
    await signOut();
  };

  // Calculate top margin for session status indicator
  const hasSessionIndicator = !isActive || showWarning;
  const topMargin = hasSessionIndicator ? 'mt-12' : '';

  return (
    <>
      <SkipLinks />
      <div className={cn('min-h-screen bg-background flex', topMargin)}>
        {/* Mobile sidebar backdrop */}
        {sidebarOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden border-0 p-0 cursor-default"
            onClick={() => setSidebarOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') {
                setSidebarOpen(false);
              }
            }}
          />
        )}

        {/* Sidebar */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-in-out md:translate-x-0 md:static md:inset-0',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          )}
          aria-label="Main navigation"
        >
          <div className="flex items-center justify-between h-16 px-6 border-b">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-lg">S</span>
              </div>
              <span className="text-xl font-semibold">Scani</span>
            </div>
            <div className="flex items-center space-x-2">
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setSidebarOpen(false)}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>

          <nav
            id={navigationId}
            className={cn('flex-1 px-4 py-4', MOBILE_SPACING.listGap)}
            aria-label="Main menu"
          >
            {navigation.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.href;

              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={cn(
                    'flex items-center space-x-3 px-3 py-3 sm:py-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch-manipulation min-h-[44px]',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className="h-5 w-5" />
                  <span>{item.name}</span>
                </Link>
              );
            })}
          </nav>

          <div className="p-4 border-t">
            <Link
              to="/settings"
              className={cn(
                'flex items-center space-x-3 px-3 py-3 sm:py-2 rounded-lg text-sm font-medium transition-colors w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch-manipulation min-h-[44px]',
                location.pathname === '/settings'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
              aria-current={location.pathname === '/settings' ? 'page' : undefined}
              onClick={() => setSidebarOpen(false)}
            >
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </Link>
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 md:ml-0">
          {/* Top bar */}
          <header className="bg-card border-b">
            <div className="h-16 flex items-center justify-between px-4 md:px-6">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
              >
                <Menu className="h-5 w-5" />
              </Button>

              <div className="flex items-center space-x-4">
                <div className="text-sm text-muted-foreground">
                  Welcome to your personal finance dashboard
                </div>
                {user && (
                  <div className="flex items-center space-x-3">
                    <div className="flex items-center space-x-2">
                      <div className="h-8 w-8 bg-muted rounded-full flex items-center justify-center">
                        <span className="text-xs font-medium">
                          {user.email?.[0]?.toUpperCase() || '?'}
                        </span>
                      </div>
                      <span className="text-sm text-muted-foreground hidden sm:inline">
                        {user.email}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleSignOut}
                      title="Sign out"
                      className="h-8 w-8"
                    >
                      <LogOut className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {/* Session status will be rendered here by SessionStatusIndicator */}
          </header>

          {/* Page content */}
          <main
            id={mainContentId}
            className={cn('flex-1', MOBILE_SPACING.containerPadding)}
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
