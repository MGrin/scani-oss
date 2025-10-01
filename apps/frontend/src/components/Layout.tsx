import {
  Building2,
  Coins,
  // CreditCard, // HIDDEN: Transaction UI temporarily hidden
  Home,
  LogOut,
  Menu,
  PieChart,
  Settings,
  Wallet,
  X,
} from 'lucide-react';
import React, { useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HelpWidget } from '@/components/help/HelpWidget';
import { CurrencySelector } from '@/components/selectors/SearchableSelectors';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EnhancedThemeToggle } from '@/components/ui/enhanced-theme-toggle';
import { MonetizationNotification } from '@/components/ui/monetization-notification';
import { QueryLoadingIndicator } from '@/components/ui/query-loading-indicator';
import { SkipLinks } from '@/components/ui/skip-links';

import { useAuth } from '@/contexts/AuthContext';
import { RealtimeProvider } from '@/contexts/RealtimeContext';
import { UnpriceableTokensProvider } from '@/contexts/UnpriceableTokensContext';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { MOBILE_SPACING } from '@/lib/mobile-utils';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface LayoutProps {
  children: React.ReactNode;
}

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Institutions', href: '/institutions', icon: Building2 },
  { name: 'Accounts', href: '/accounts', icon: Wallet },
  { name: 'Tokens', href: '/tokens', icon: Coins },
  { name: 'Holdings', href: '/holdings', icon: PieChart },
  // { name: 'Transactions', href: '/transactions', icon: CreditCard }, // HIDDEN: Transaction UI temporarily hidden
];

// Helper function to determine which navigation item should be active
function getActiveNavItem(pathname: string): string {
  // Exact matches first
  if (pathname === '/') return '/';
  if (pathname === '/institutions') return '/institutions';
  if (pathname === '/accounts') return '/accounts';
  if (pathname === '/tokens') return '/tokens';
  if (pathname === '/holdings') return '/holdings';
  // if (pathname === '/transactions') return '/transactions'; // HIDDEN: Transaction UI temporarily hidden

  // Hierarchical path matches based on what page is actually rendered
  if (pathname.match(/^\/institutions\/[^/]+$/)) {
    // /institutions/:institutionId -> renders Accounts page
    return '/accounts';
  }
  if (pathname.match(/^\/institutions\/[^/]+\/accounts\/[^/]+$/)) {
    // /institutions/:institutionId/accounts/:accountId -> renders Holdings page
    return '/holdings';
  }
  // HIDDEN: Transaction UI temporarily hidden
  // if (pathname.match(/^\/institutions\/[^/]+\/accounts\/[^/]+\/holdings\/[^/]+$/)) {
  //   // /institutions/:institutionId/accounts/:accountId/holdings/:holdingId -> renders Transactions page
  //   return '/transactions';
  // }

  // Default fallback
  return '';
}

// Helper hook to generate breadcrumbs based on the current path with entity names
function useBreadcrumbs(pathname: string) {
  // Parse URL to extract entity IDs based on actual routing structure
  const pathSegments = pathname.split('/').filter(Boolean);

  // Extract IDs from URL patterns
  let institutionId = null;
  let accountId = null;
  let holdingId = null;

  // /institutions/:institutionId → show institution accounts
  if (pathSegments[0] === 'institutions' && pathSegments[1]) {
    institutionId = pathSegments[1];

    // /institutions/:institutionId/accounts/:accountId → show account holdings
    if (pathSegments[2] === 'accounts' && pathSegments[3]) {
      accountId = pathSegments[3];

      // /institutions/:institutionId/accounts/:accountId/holdings/:holdingId → show holding details
      if (pathSegments[4] === 'holdings' && pathSegments[5]) {
        holdingId = pathSegments[5];
      }
    }
  }

  // Query data only when needed
  const { data: institution } = trpc.institutions.getById.useQuery(
    { id: institutionId ?? '' },
    {
      enabled: Boolean(institutionId),
    }
  );
  const { data: account } = trpc.accounts.getById.useQuery(
    { id: accountId ?? '' },
    {
      enabled: Boolean(accountId),
    }
  );
  const { data: holding } = trpc.holdings.getById.useQuery(
    { id: holdingId ?? '' },
    {
      enabled: Boolean(holdingId),
    }
  );

  // Generate breadcrumbs
  const breadcrumbs = [{ name: 'Dashboard', href: '/', isHome: true }];

  // Special handling for specific routes
  const routeMap: Record<string, string> = {
    institutions: 'Institutions',
    accounts: 'Accounts',
    tokens: 'Tokens',
    holdings: 'Holdings',
    // transactions: 'Transactions', // HIDDEN: Transaction UI temporarily hidden
    settings: 'Settings',
    'quick-add-holding': 'Add Holding',
  };

  let currentPath = '';
  pathSegments.forEach((segment, index) => {
    currentPath += `/${segment}`;

    // Default name from route map or capitalize segment
    let name = routeMap[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);

    // Override with entity names when available
    if (pathSegments[0] === 'institutions') {
      if (index === 1 && institutionId === segment) {
        // Institution ID segment - show institution name
        if (institution) {
          name = institution.name;
        }
      } else if (index === 3 && segment && accountId === segment) {
        // Account ID segment in /institutions/:id/accounts/:accountId
        if (account) {
          name = account.name;
        }
      } else if (index === 5 && segment && holdingId === segment) {
        // Holding ID segment in /institutions/:id/accounts/:id/holdings/:holdingId
        if (holding) {
          name = holding.tokenSymbol || holding.tokenName || name;
        }
      }
      // Skip 'accounts' and 'holdings' literal segments in nested paths - they're redundant
      else if (
        (segment === 'accounts' && pathSegments.length > 2) ||
        (segment === 'holdings' && pathSegments.length > 4)
      ) {
        return; // Skip adding this breadcrumb
      }
    }

    breadcrumbs.push({
      name,
      href: currentPath,
      isHome: false,
    });
  });

  // Special case: if we're on a hierarchical holding route that shows transactions
  // (i.e., /institutions/:id/accounts/:id/holdings/:id), modify the last breadcrumb to be "Transactions"
  if (holdingId && pathSegments.length === 6 && pathSegments[4] === 'holdings') {
    // The last breadcrumb should be "Transactions" instead of the holding name
    const lastBreadcrumb = breadcrumbs[breadcrumbs.length - 1];
    if (lastBreadcrumb) {
      lastBreadcrumb.name = 'Transactions';
    }
  }

  return breadcrumbs;
}

export function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationDismissed, setNotificationDismissed] = useState(false);
  const location = useLocation();
  const { signOut, user } = useAuth();
  const navigationId = useId();
  const mainContentId = useId();

  // Query for user preferences to get avatar and name
  const { data: userPrefs } = trpc.users.getCurrent.useQuery(undefined, {
    enabled: Boolean(user), // Only query if user is logged in
  });

  // Query for supported currencies for currency selector
  const { data: supportedCurrencies } = trpc.users.getSupportedCurrencies.useQuery(undefined, {
    enabled: Boolean(user), // Only query if user is logged in
  });

  // Query for base currency
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery(undefined, {
    enabled: Boolean(user), // Only query if user is logged in
  });

  const { success, error: showError } = useEnhancedToast();
  const utils = trpc.useUtils();
  const updateUser = trpc.users.updateCurrent.useMutation({
    onSuccess: () => {
      utils.users.getBaseCurrency.invalidate();
      utils.users.getPortfolioValue.invalidate();
      success(
        'Currency updated successfully. All values will now be displayed in the new currency.'
      );
    },
    onError: (err) => {
      showError(err.message || 'Failed to update currency');
    },
  });

  const handleCurrencyChange = (currencyId: string) => {
    updateUser.mutate({ baseCurrencyId: currencyId });
  };

  // Query for unpriceable tokens to show monetization notification
  const { data: unpriceableTokens } = trpc.holdings.getUnpriceableTokens.useQuery(undefined, {
    enabled: Boolean(user), // Only query if user is logged in
    refetchOnWindowFocus: false, // Don't refetch on window focus to avoid spam
  });

  const handleSignOut = async () => {
    await signOut();
  };

  // Generate breadcrumbs for current path
  const breadcrumbs = useBreadcrumbs(location.pathname);

  return (
    <RealtimeProvider>
      <SkipLinks />
      <UnpriceableTokensProvider
        unpriceableTokens={unpriceableTokens?.tokens}
        notificationDismissed={notificationDismissed}
      >
        <LayoutContent
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          notificationDismissed={notificationDismissed}
          setNotificationDismissed={setNotificationDismissed}
          user={user}
          userPrefs={userPrefs}
          supportedCurrencies={supportedCurrencies}
          baseCurrency={baseCurrency}
          handleCurrencyChange={handleCurrencyChange}
          handleSignOut={handleSignOut}
          breadcrumbs={breadcrumbs}
          navigationId={navigationId}
          mainContentId={mainContentId}
          unpriceableTokens={unpriceableTokens}
        >
          {children}
        </LayoutContent>
      </UnpriceableTokensProvider>
    </RealtimeProvider>
  );
}

interface User {
  email?: string;
}

interface BreadcrumbData {
  name: string;
  href: string;
  isHome: boolean;
}

interface UnpriceableToken {
  symbol: string;
  balance: string;
  reason: string;
  provider: string;
  providerPricingUrl?: string;
  institutionName: string;
  accountName: string;
}

interface UnpriceableTokensData {
  count: number;
  tokens: UnpriceableToken[];
  baseCurrency: string;
}

interface LayoutContentProps {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  notificationDismissed: boolean;
  setNotificationDismissed: (dismissed: boolean) => void;
  user: User | null;
  userPrefs?: {
    name: string | null;
    email: string;
    avatar: string | null;
  };
  supportedCurrencies?: Array<{
    id: string;
    symbol: string;
    name: string;
  }>;
  baseCurrency?: {
    id: string;
    symbol: string;
    name: string;
  } | null;
  handleCurrencyChange: (currencyId: string) => void;
  handleSignOut: () => Promise<void>;
  breadcrumbs: BreadcrumbData[];
  navigationId: string;
  mainContentId: string;
  unpriceableTokens: UnpriceableTokensData | undefined;
  children: React.ReactNode;
}

function LayoutContent({
  sidebarOpen,
  setSidebarOpen,
  notificationDismissed,
  setNotificationDismissed,
  user,
  userPrefs,
  supportedCurrencies,
  baseCurrency,
  handleCurrencyChange,
  handleSignOut,
  breadcrumbs,
  navigationId,
  mainContentId,
  unpriceableTokens,
  children,
}: LayoutContentProps) {
  return (
    <div className="h-screen bg-background flex">
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
        <div className="flex items-center justify-between h-14 px-4 border-b">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-base">S</span>
            </div>
            <span className="text-lg font-semibold">Scani</span>
          </div>
          <div className="flex items-center space-x-1">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden h-7 w-7"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <nav
          id={navigationId}
          className={cn('flex-1 px-3 py-3 mt-2 overflow-y-auto', MOBILE_SPACING.listGap)}
          aria-label="Main menu"
        >
          {navigation.map((item) => {
            const Icon = item.icon;
            const activeNavItem = getActiveNavItem(location.pathname);
            const isActive = activeNavItem === item.href;

            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  'flex items-center space-x-2.5 px-2.5 py-2 sm:py-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch-manipulation min-h-[36px]',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon className="h-4 w-4" />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 md:ml-0 flex flex-col h-screen">
        {/* Top bar - not fixed, takes natural space */}
        <header className="flex-shrink-0 bg-card border-b">
          <div className="h-14 flex items-center justify-between px-3 md:px-4">
            {/* Left side - Mobile menu button and Breadcrumbs */}
            <div className="flex items-center space-x-3">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden h-7 w-7"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
              >
                <Menu className="h-4 w-4" />
              </Button>

              {/* Breadcrumbs */}
              <Breadcrumb className="hidden md:flex">
                <BreadcrumbList>
                  {breadcrumbs.map((crumb: BreadcrumbData, index: number) => (
                    <React.Fragment key={`${crumb.href}-${index}`}>
                      <BreadcrumbItem>
                        {index === breadcrumbs.length - 1 ? (
                          <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink to={crumb.href}>
                            {crumb.isHome ? <Home className="h-3.5 w-3.5" /> : crumb.name}
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {index < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
                    </React.Fragment>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
            </div>

            {/* Right side - User menu and theme toggle */}
            <div className="flex items-center space-x-3">
              {user && (
                <>
                  {/* Currency Selector */}
                  {supportedCurrencies && supportedCurrencies.length > 0 && (
                    <CurrencySelector
                      value={baseCurrency?.id || ''}
                      onValueChange={handleCurrencyChange}
                      currencies={supportedCurrencies}
                      placeholder="Currency"
                      popoverWidth="w-80"
                      compact={true}
                      buttonSize="sm"
                      className="w-24"
                    />
                  )}

                  {/* Theme Toggle */}
                  <EnhancedThemeToggle />

                  {/* User Menu */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        className="flex items-center space-x-1.5 h-auto p-1.5"
                      >
                        <div className="h-7 w-7 bg-muted rounded-full flex items-center justify-center overflow-hidden">
                          {userPrefs?.avatar ? (
                            <img
                              src={userPrefs.avatar}
                              alt={userPrefs.name || user.email || 'User'}
                              className="h-full w-full object-cover"
                              onError={(e) => {
                                // Hide the image and show fallback if it fails to load
                                e.currentTarget.style.display = 'none';
                              }}
                            />
                          ) : null}
                          {!userPrefs?.avatar && (
                            <span className="text-xs font-medium">
                              {(userPrefs?.name?.[0] || user.email?.[0])?.toUpperCase() || '?'}
                            </span>
                          )}
                        </div>
                        <span className="text-sm hidden sm:inline">
                          {userPrefs?.name || user.email?.split('@')[0] || 'User'}
                        </span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuLabel className="font-normal">
                        <div className="flex flex-col space-y-0.5">
                          <p className="text-sm font-medium leading-none">
                            {userPrefs?.name || user.email?.split('@')[0] || 'User'}
                          </p>
                          <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
                        </div>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link to="/settings" className="flex items-center space-x-1.5 w-full">
                          <Settings className="h-3.5 w-3.5" />
                          <span>Settings</span>
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={handleSignOut}
                        className="flex items-center space-x-1.5 text-red-600"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        <span>Sign out</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </div>
          {/* Session status will be rendered here by SessionStatusIndicator */}
        </header>

        {/* Loading indicator for query refetches */}
        <QueryLoadingIndicator />

        {/* Monetization notification for unpriceable tokens */}
        {unpriceableTokens && unpriceableTokens.count > 0 && !notificationDismissed && (
          <div className="px-4 sm:px-6 pt-4">
            <MonetizationNotification
              unpriceableTokens={unpriceableTokens.tokens}
              onDismiss={() => setNotificationDismissed(true)}
            />
          </div>
        )}

        {/* Page content - scrollable */}
        <main
          id={mainContentId}
          className={cn('flex-1 overflow-y-auto px-4 pt-4 pb-6 sm:px-6 sm:pt-5 sm:pb-6')}
          tabIndex={-1}
        >
          {children}
        </main>

        {/* Help Widget */}
        <HelpWidget />
      </div>
    </div>
  );
}
