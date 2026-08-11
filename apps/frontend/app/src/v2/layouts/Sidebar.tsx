import { ThemeToggle } from '@scani/ui/components/ThemeToggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@scani/ui/ui/tooltip';
import {
  Building2,
  CalendarClock,
  ChevronLeft,
  ClipboardCheck,
  Coins,
  FileText,
  FileUp,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  LogOut,
  type LucideIcon,
  Menu,
  PieChart,
  Plug,
  Repeat,
  Settings,
  Store,
  Tags,
  Vault,
  Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { useReviewFeed } from '../hooks/useReviewFeed';
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from '../lib/constants';
import { NAV_SECTIONS, resolveActiveNavPath, V2_ROUTES } from '../lib/routes';

const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  PieChart,
  Wallet,
  Building2,
  Tags,
  Vault,
  Plug,
  FileUp,
  FileText,
  Keyboard,
  Coins,
  ListChecks,
  ClipboardCheck,
  CalendarClock,
  Repeat,
  Store,
};

const navItemBase =
  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors w-full';

const collapsedItemBase = 'p-1.5 rounded-md transition-colors flex items-center justify-center';

const activeClass = 'bg-accent text-accent-foreground font-medium';
const inactiveClass = 'text-muted-foreground hover:bg-accent/50 hover:text-foreground';

function SidebarNavLink({
  to,
  icon: Icon,
  label,
  collapsed,
  active,
  badgeCount,
  anchorRef,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  /** Resolved by the caller via `resolveActiveNavPath`. Omitted for
   * entries outside `NAV_SECTIONS` (Settings), which fall back to
   * `NavLink`'s own exact matching. */
  active?: boolean;
  /** Lets the sidebar scroll this entry into view when it matters. */
  anchorRef?: React.Ref<HTMLAnchorElement>;
  /** Optional numeric badge (e.g. action-required jobs count). Renders
   * in amber to draw attention; hidden when 0 or undefined. */
  badgeCount?: number;
}) {
  const { pathname } = useLocation();
  const hasBadge = typeof badgeCount === 'number' && badgeCount > 0;

  if (collapsed) {
    const isActive = active ?? pathname === to;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={to}
            aria-label={hasBadge ? `${label} (${badgeCount} pending)` : label}
            aria-current={isActive ? 'page' : undefined}
            className={cn(collapsedItemBase, isActive ? activeClass : inactiveClass, 'relative')}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            {hasBadge && (
              <span
                // Amber dot in the upper-right corner of the collapsed
                // icon — no room for a number but the dot alone signals
                // "you have pending reviews".
                className="absolute top-0 right-0 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-card"
                aria-hidden="true"
              />
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {hasBadge ? `${label} · ${badgeCount} to review` : label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <NavLink
      ref={anchorRef}
      to={to}
      end
      className={({ isActive }) =>
        cn(navItemBase, (active ?? isActive) ? activeClass : inactiveClass)
      }
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {hasBadge && (
        <output
          aria-label={`${badgeCount} pending`}
          className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-300"
        >
          {badgeCount}
        </output>
      )}
    </NavLink>
  );
}

function SidebarButton({
  icon: Icon,
  label,
  collapsed,
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  onClick: () => void;
  className?: string;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className={cn(collapsedItemBase, inactiveClass, className)}
          >
            <Icon className="h-5 w-5 shrink-0" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        navItemBase,
        'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        className
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { signOut } = useAuth();
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const activeNavPath = resolveActiveNavPath(pathname);
  const { count: actionRequiredCount } = useReviewFeed();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const reviewNavRef = useRef<HTMLAnchorElement>(null);
  const [hasHiddenBelow, setHasHiddenBelow] = useState(false);

  const updateOverflowHint = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setHasHiddenBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  }, []);

  // Observe the nav CONTENT, not the scroll container. The container is
  // `flex-1` inside a fixed-height aside, so its box never changes when
  // the nav grows — a badge arriving once useReviewFeed resolves would
  // otherwise never re-fire the hint, leaving it stale.
  useEffect(() => {
    updateOverflowHint();
    const content = navRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflowHint);
    observer.observe(content);
    return () => observer.disconnect();
  }, [updateOverflowHint]);

  // Pull the Review entry into view when something is waiting. It sits in
  // the last nav section, so on a short viewport it is exactly the item
  // that falls below the fold — the same treatment AppShell already gives
  // its mobile drawer.
  useEffect(() => {
    if (actionRequiredCount === 0) return;
    reviewNavRef.current?.scrollIntoView({ block: 'nearest' });
  }, [actionRequiredCount]);

  const handleSignOut = () => {
    // Fire and forget. ProtectedRoute will redirect to /auth when the
    // session disappears, so there's no explicit navigation to do here.
    void signOut();
  };

  return (
    <aside
      aria-label="Primary"
      className={cn(
        'hidden lg:flex flex-col border-r border-border bg-card transition-all duration-200',
        collapsed ? 'w-12' : 'w-60'
      )}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center border-b border-border shrink-0',
          collapsed ? 'justify-center px-1' : 'justify-between px-3'
        )}
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          minHeight: 'calc(3rem + env(safe-area-inset-top))',
        }}
      >
        {!collapsed && <span className="text-base font-semibold tracking-tight">Scani</span>}
        <button
          type="button"
          onClick={onToggle}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
          aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
        >
          {collapsed ? <Menu className="h-5 w-5" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/*
        Navigation. `relative` anchors the overflow hint below; without a
        scroll cue the hidden sections read as "not there" rather than
        "scroll down" — measured on a 577px viewport, 701px of nav in a
        378px scroller left ADD DATA and ACTIVITY entirely invisible.
      */}
      <div
        ref={scrollerRef}
        onScroll={updateOverflowHint}
        className="relative flex-1 overflow-y-auto py-2"
      >
        <nav ref={navRef} className={cn('space-y-3', collapsed ? 'px-1' : 'px-2')}>
          {NAV_SECTIONS.map((section, idx) => (
            <div key={section.titleKey}>
              {collapsed && idx > 0 && <div className="border-t border-border mb-2" />}
              {!collapsed && (
                <p className="px-2 mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  {t(section.titleKey)}
                </p>
              )}
              <div className={collapsed ? 'space-y-1' : 'space-y-px'}>
                {section.items.map((item) => {
                  const Icon = ICON_MAP[item.icon] || PieChart;
                  return (
                    <SidebarNavLink
                      key={item.path}
                      to={item.path}
                      icon={Icon}
                      label={t(item.labelKey)}
                      collapsed={collapsed}
                      active={item.path === activeNavPath}
                      badgeCount={item.path === V2_ROUTES.review ? actionRequiredCount : undefined}
                      anchorRef={item.path === V2_ROUTES.review ? reviewNavRef : undefined}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>
      {hasHiddenBelow && (
        <div
          aria-hidden="true"
          className="pointer-events-none -mt-6 h-6 shrink-0 bg-gradient-to-t from-card to-transparent"
        />
      )}

      {/* Footer */}
      <div className={cn('border-t border-border', collapsed ? 'p-1 space-y-1' : 'p-2 space-y-px')}>
        <SidebarNavLink
          to={V2_ROUTES.settings}
          icon={Settings}
          label={t('nav.settings')}
          collapsed={collapsed}
        />
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ThemeToggle variant="icon" side="right" align="end" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {t('nav.theme')}
            </TooltipContent>
          </Tooltip>
        ) : (
          <ThemeToggle variant="row" side="top" align="start" />
        )}
        <SidebarButton
          icon={LogOut}
          label={t('nav.signOut')}
          collapsed={collapsed}
          onClick={handleSignOut}
          className="text-red-600 hover:text-red-600 hover:bg-red-600/10"
        />
      </div>
    </aside>
  );
}
