import {
  CreditCard,
  FileText,
  Home,
  LogOut,
  Menu,
  Settings,
  TrendingUp,
  X,
} from "lucide-react";
import React, { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  AccountBreadcrumb,
  InstitutionBreadcrumb,
} from "@/components/features/Breadcrumb";
import { PullToRefresh } from "@/components/PullToRefresh";
import { CurrencySelector } from "@/components/selectors/CurrencySelector";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnhancedThemeToggle } from "@/components/ui/enhanced-theme-toggle";
import { QueryLoadingIndicator } from "@/components/ui/query-loading-indicator";
import { Skeleton } from "@/components/ui/skeleton";
import { SkipLinks } from "@/components/ui/skip-links";
import { SvgIcon } from "@/components/ui/SvgIcon";

import { useAuth } from "@/contexts/AuthContext";
import { RealtimeProvider } from "@/contexts/RealtimeContext";
import { showError, useToast } from "@/hooks/use-toast";
import { MOBILE_SPACING } from "@/lib/mobile-utils";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

const navigation = [
  { name: "Dashboard", href: "/", icon: Home },
  { name: "Accounts", href: "/accounts", icon: CreditCard },
  { name: "Holdings", href: "/holdings", icon: TrendingUp },
  { name: "Settings", href: "/settings", icon: Settings },
];

const comingSoonNavigation = [
  { name: "Reports", href: "/reports", icon: FileText },
  { name: "Schedules", href: "/schedules", icon: Settings },
];

// Helper function to determine which navigation item should be active
function getActiveNavItem(pathname: string): string {
  if (pathname === "/") return "/";
  if (pathname.startsWith("/accounts")) return "/accounts";
  if (pathname.startsWith("/holdings")) return "/holdings";
  if (pathname.startsWith("/settings")) return "/settings";
  return "";
}

// Helper hook to generate breadcrumbs based on the current path
function useBreadcrumbs(pathname: string) {
  const pathSegments = pathname.split("/").filter(Boolean);

  const breadcrumbs = [{ name: "Dashboard", href: "/", isHome: true }];

  const routeMap: Record<string, string> = {
    accounts: "Accounts",
    holdings: "Holdings",
    settings: "Settings",
  };

  let currentPath = "";
  pathSegments.forEach((segment) => {
    currentPath += `/${segment}`;
    const name =
      routeMap[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);

    breadcrumbs.push({
      name,
      href: currentPath,
      isHome: false,
    });
  });

  return breadcrumbs;
}

export function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const location = useLocation();
  const { signOut, user } = useAuth();
  const navigationId = useId();
  const mainContentId = useId();

  // Detect mobile screen size
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768); // md breakpoint
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Query for user preferences to get avatar and name
  const { data: userPrefs } = trpc.users.getCurrent.useQuery(undefined, {
    enabled: Boolean(user),
  });

  // Query for supported currencies for currency selector
  const { data: supportedCurrencies } =
    trpc.users.getSupportedCurrencies.useQuery(undefined, {
      enabled: Boolean(user),
    });

  // Query for base currency
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery(
    undefined,
    {
      enabled: Boolean(user),
    }
  );

  const { toast } = useToast();
  const utils = trpc.useUtils();
  const updateUser = trpc.users.updateCurrent.useMutation({
    onSuccess: () => {
      // Invalidate all queries that depend on base currency
      utils.users.getBaseCurrency.invalidate();
      utils.users.getCurrent.invalidate();
      utils.dashboard.getOverview.invalidate();
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.institutions.getByUserIdWithSummary.invalidate();

      toast({
        title: "Success",
        description:
          "Currency updated successfully. All values will now be displayed in the new currency.",
        variant: "default",
      });
    },
    onError: (err) => showError(err, "Updating currency"),
  });

  const handleCurrencyChange = (currencyId: string) => {
    updateUser.mutate({ baseCurrencyId: currencyId });
  };

  const handleSignOut = async () => {
    await signOut();
  };

  // Handle pull-to-refresh
  const handleRefresh = async () => {
    await utils.invalidate();
  };

  // Generate breadcrumbs for current path
  const breadcrumbs = useBreadcrumbs(location.pathname);

  return (
    <RealtimeProvider>
      <SkipLinks />
      <LayoutContent
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        user={user}
        userPrefs={userPrefs}
        supportedCurrencies={supportedCurrencies}
        baseCurrency={baseCurrency}
        handleCurrencyChange={handleCurrencyChange}
        handleSignOut={handleSignOut}
        handleRefresh={handleRefresh}
        breadcrumbs={breadcrumbs}
        navigationId={navigationId}
        mainContentId={mainContentId}
        isMobile={isMobile}
      >
        {children}
      </LayoutContent>
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

interface LayoutContentProps {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
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
  handleRefresh: () => Promise<void>;
  breadcrumbs: BreadcrumbData[];
  navigationId: string;
  mainContentId: string;
  isMobile: boolean;
  children: React.ReactNode;
}

function LayoutContent({
  sidebarOpen,
  setSidebarOpen,
  user,
  userPrefs,
  supportedCurrencies,
  baseCurrency,
  handleCurrencyChange,
  handleSignOut,
  handleRefresh,
  breadcrumbs,
  navigationId,
  mainContentId,
  isMobile,
  children,
}: LayoutContentProps) {
  const location = useLocation();

  return (
    <div className="h-screen bg-background flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden border-0 p-0 cursor-default"
          onClick={() => setSidebarOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              setSidebarOpen(false);
            }
          }}
          aria-label="Close sidebar"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-in-out md:translate-x-0 md:static md:inset-0 flex flex-col",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: "env(safe-area-inset-left)",
        }}
        aria-label="Main navigation"
      >
        {/* Logo and close button */}
        <div className="flex items-center justify-between h-14 px-4 border-b flex-shrink-0">
          <SvgIcon name="scani-logo" className="h-8 w-20" aria-label="Scani" />
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-7 w-7"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Navigation */}
        <nav
          id={navigationId}
          className={cn(
            "flex-1 px-3 py-3 mt-2 overflow-y-auto",
            MOBILE_SPACING.listGap
          )}
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
                  "flex items-center space-x-2.5 px-2.5 py-2 sm:py-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch-manipulation min-h-[36px]",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span>{item.name}</span>
              </Link>
            );
          })}

          {/* Coming Soon Section */}
          <div className="mt-6 pt-4 border-t border-border/50">
            <div className="px-2.5 mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Coming Soon
              </h3>
            </div>
            <div className="space-y-1">
              {comingSoonNavigation.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.name}
                    className="flex items-center space-x-2.5 px-2.5 py-1.5 rounded-md cursor-not-allowed opacity-50 text-muted-foreground text-sm"
                  >
                    <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-sm">{item.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Bottom section - Currency, User */}
        <div className="border-t p-3 space-y-3 flex-shrink-0">
          {/* Base Currency - Always visible */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground px-1">
              Base Currency
            </div>
            {supportedCurrencies && supportedCurrencies.length > 0 ? (
              <CurrencySelector
                value={baseCurrency?.id || ""}
                onValueChange={handleCurrencyChange}
                currencies={supportedCurrencies}
                placeholder="Select currency"
                popoverWidth="w-80"
                compact={false}
                buttonSize="sm"
                className="w-full"
                side={isMobile ? "bottom" : "right"}
              />
            ) : (
              <Skeleton className="h-9 w-full" />
            )}
          </div>

          {/* User Profile Dropdown */}
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="w-full justify-start h-auto p-2"
                >
                  <div className="flex items-center space-x-2 w-full">
                    <div className="h-8 w-8 bg-muted rounded-full flex items-center justify-center overflow-hidden flex-shrink-0">
                      {userPrefs?.avatar ? (
                        <img
                          src={userPrefs.avatar}
                          alt={userPrefs.name || user.email || "User"}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : null}
                      {!userPrefs?.avatar && (
                        <span className="text-sm font-medium">
                          {(
                            userPrefs?.name?.[0] || user.email?.[0]
                          )?.toUpperCase() || "?"}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 text-left overflow-hidden">
                      <p className="text-sm font-medium truncate">
                        {userPrefs?.name || user.email?.split("@")[0] || "User"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {user.email}
                      </p>
                    </div>
                  </div>
                </Button>
              </DropdownMenuTrigger>
              {/* Mobile: full width above trigger, Desktop: to the right */}
              <DropdownMenuContent
                align={isMobile ? "center" : "start"}
                side={isMobile ? "top" : "right"}
                sideOffset={isMobile ? 4 : 8}
                className={cn(isMobile ? "w-[calc(16rem-2rem)]" : "w-56")}
              >
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">
                      {userPrefs?.name || user.email?.split("@")[0] || "User"}
                    </p>
                    <p className="text-sm leading-none text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link
                    to="/settings"
                    className="flex items-center gap-2 w-full text-sm cursor-pointer"
                  >
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleSignOut}
                  className="flex items-center gap-2 text-red-600 text-sm cursor-pointer"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 md:ml-0 flex flex-col">
        {/* Top bar */}
        <header
          className="flex-shrink-0 bg-card border-b"
          style={{
            paddingTop: "max(env(safe-area-inset-top), 0px)",
          }}
        >
          <div className="h-14 flex items-center justify-between px-3 md:px-4">
            {/* Left side - Mobile menu button and Breadcrumbs */}
            <div className="flex items-center space-x-3 flex-1 min-w-0">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden h-7 w-7 flex-shrink-0"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
              >
                <Menu className="h-4 w-4" />
              </Button>

              {/* Breadcrumbs - hide on mobile */}
              {location.pathname.startsWith("/accounts/") ? (
                <AccountBreadcrumb />
              ) : location.pathname.startsWith("/institutions/") ? (
                <InstitutionBreadcrumb />
              ) : (
                <Breadcrumb className="hidden md:flex min-w-0 flex-1">
                  <BreadcrumbList className="flex-wrap">
                    {breadcrumbs.map((crumb: BreadcrumbData, index: number) => (
                      <React.Fragment key={`${crumb.href}-${index}`}>
                        <BreadcrumbItem className="max-w-[200px]">
                          {index === breadcrumbs.length - 1 ? (
                            <BreadcrumbPage className="truncate">
                              {crumb.name}
                            </BreadcrumbPage>
                          ) : (
                            <BreadcrumbLink
                              to={crumb.href}
                              className="truncate block"
                            >
                              {crumb.isHome ? (
                                <Home className="h-3.5 w-3.5" />
                              ) : (
                                crumb.name
                              )}
                            </BreadcrumbLink>
                          )}
                        </BreadcrumbItem>
                        {index < breadcrumbs.length - 1 && (
                          <BreadcrumbSeparator />
                        )}
                      </React.Fragment>
                    ))}
                  </BreadcrumbList>
                </Breadcrumb>
              )}
            </div>

            {/* Right side - Theme toggle (always visible) */}
            <div className="flex items-center space-x-3 flex-shrink-0">
              {user && <EnhancedThemeToggle />}
            </div>
          </div>
        </header>

        {/* Loading indicator */}
        <QueryLoadingIndicator />

        {/* Page content - scrollable with pull-to-refresh */}
        <PullToRefresh onRefresh={handleRefresh}>
          <div className="h-full overflow-auto" data-scrollable="true">
            <main
              id={mainContentId}
              className={cn("px-4 pt-4 pb-6 sm:px-6 sm:pt-5 sm:pb-6")}
              style={{
                paddingBottom:
                  "max(1.5rem, calc(1.5rem + env(safe-area-inset-bottom)))",
                paddingLeft:
                  "max(1rem, calc(1rem + env(safe-area-inset-left)))",
                paddingRight:
                  "max(1rem, calc(1rem + env(safe-area-inset-right)))",
              }}
              tabIndex={-1}
            >
              {children}
            </main>
          </div>
        </PullToRefresh>
      </div>

      {/** biome-ignore lint/correctness/useUniqueElementIds: portal */}
      <div id="mobile-bottom-nav" className="relative" />
    </div>
  );
}
