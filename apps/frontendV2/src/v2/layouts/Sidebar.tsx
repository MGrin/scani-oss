import {
  Building2,
  ChevronLeft,
  Coins,
  FileUp,
  Keyboard,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  Moon,
  PieChart,
  Plug,
  Settings,
  Sun,
  Tags,
  Vault,
  Wallet,
} from 'lucide-react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from '../lib/constants';
import { NAV_SECTIONS, V2_ROUTES } from '../lib/routes';

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
  end,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  end?: boolean;
}) {
  const { pathname } = useLocation();

  if (collapsed) {
    const isActive = end ? pathname === to : pathname.startsWith(to);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={to}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            className={cn(collapsedItemBase, isActive ? activeClass : inactiveClass)}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn(navItemBase, isActive ? activeClass : inactiveClass)}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
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
  const { resolvedTheme, toggleTheme } = useTheme();
  const { signOut } = useAuth();

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
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu className="h-5 w-5" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-2">
        <nav className={cn('space-y-3', collapsed ? 'px-1' : 'px-2')}>
          {NAV_SECTIONS.map((section, idx) => (
            <div key={section.title}>
              {collapsed && idx > 0 && <div className="border-t border-border mb-2" />}
              {!collapsed && (
                <p className="px-2 mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  {section.title}
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
                      label={item.label}
                      collapsed={collapsed}
                      end={item.path === V2_ROUTES.dashboard}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* Footer */}
      <div className={cn('border-t border-border', collapsed ? 'p-1 space-y-1' : 'p-2 space-y-px')}>
        <SidebarNavLink
          to={V2_ROUTES.settings}
          icon={Settings}
          label="Settings"
          collapsed={collapsed}
        />
        <SidebarButton
          icon={resolvedTheme === 'dark' ? Sun : Moon}
          label={resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
          collapsed={collapsed}
          onClick={toggleTheme}
        />
        <SidebarButton
          icon={LogOut}
          label="Sign out"
          collapsed={collapsed}
          onClick={handleSignOut}
          className="text-red-600 hover:text-red-600 hover:bg-red-600/10"
        />
      </div>
    </aside>
  );
}
