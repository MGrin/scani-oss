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
import { NavLink } from 'react-router-dom';
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

const navItemClass = (isActive: boolean) =>
  cn(
    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors w-full',
    isActive
      ? 'bg-accent text-accent-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
  );

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
  const link = (
    <NavLink to={to} end={end} className={({ isActive }) => navItemClass(isActive)}>
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
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
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors w-full',
        className
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );

  if (!collapsed) return btn;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
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
      className={cn(
        'hidden lg:flex flex-col border-r border-border bg-card transition-all duration-200',
        collapsed ? 'w-12' : 'w-60'
      )}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 border-b border-border shrink-0"
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
          {collapsed ? <Menu className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-2">
        <nav className="space-y-3 px-2">
          {NAV_SECTIONS.map((section, idx) => (
            <div key={section.title}>
              {collapsed && idx > 0 && <div className="border-t border-border mb-2 -mx-1" />}
              {!collapsed && (
                <p className="px-2 mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  {section.title}
                </p>
              )}
              <div className="space-y-px">
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
      <div className="border-t border-border p-2 space-y-px">
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
