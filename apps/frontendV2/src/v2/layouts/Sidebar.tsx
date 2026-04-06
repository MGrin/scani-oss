import {
  Building2,
  ChevronLeft,
  FileUp,
  LayoutDashboard,
  type LucideIcon,
  Menu,
  PieChart,
  Plug,
  Settings,
  Tags,
  Vault,
  Wallet,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
};

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col border-r border-border bg-muted/30 transition-all duration-200',
        collapsed ? 'w-12' : 'w-60'
      )}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-14 px-3 border-b border-border">
        {!collapsed && <span className="text-lg font-semibold tracking-tight">Scani</span>}
        <button
          type="button"
          onClick={onToggle}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-4 px-2">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              {!collapsed && (
                <p className="px-2 mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {section.title}
                </p>
              )}
              {collapsed && <Separator className="my-1" />}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = ICON_MAP[item.icon] || PieChart;
                  return (
                    <Tooltip key={item.path}>
                      <TooltipTrigger asChild>
                        <NavLink
                          to={item.path}
                          end={item.path === V2_ROUTES.dashboard}
                          className={({ isActive }) =>
                            cn(
                              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                              isActive
                                ? 'bg-accent text-accent-foreground font-medium'
                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                            )
                          }
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span className="truncate">{item.label}</span>}
                        </NavLink>
                      </TooltipTrigger>
                      {collapsed && (
                        <TooltipContent side="right" sideOffset={8}>
                          {item.label}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>

      {/* Footer */}
      <div className="border-t border-border p-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to={V2_ROUTES.settings}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )
              }
            >
              <Settings className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Settings</span>}
            </NavLink>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right" sideOffset={8}>
              Settings
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </aside>
  );
}
