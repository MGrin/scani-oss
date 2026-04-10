import {
  ArrowLeft,
  Building2,
  ChevronLeft,
  FileUp,
  LayoutDashboard,
  type LucideIcon,
  Menu,
  Moon,
  PieChart,
  Plug,
  PlusCircle,
  Settings,
  Sun,
  Tags,
  Vault,
  Wallet,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
};

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { resolvedTheme, toggleTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors w-full"
        >
          {resolvedTheme === 'dark' ? (
            <Sun className="h-4 w-4 shrink-0" />
          ) : (
            <Moon className="h-4 w-4 shrink-0" />
          )}
          {!collapsed && <span>{resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode</span>}
        </button>
      </TooltipTrigger>
      {collapsed && (
        <TooltipContent side="right" sideOffset={8}>
          {resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
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
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Add Data button */}
      <div className="px-2 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to={V2_ROUTES.addData}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )
              }
            >
              <PlusCircle className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Add Data</span>}
            </NavLink>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right" sideOffset={8}>
              Add Data
            </TooltipContent>
          )}
        </Tooltip>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-3 px-2">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              {!collapsed && (
                <p className="px-2 mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  {section.title}
                </p>
              )}
              <div className="space-y-px">
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
                              'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors',
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
      <div className="border-t border-border p-2 space-y-px">
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to={V2_ROUTES.settings}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors',
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
        <ThemeToggle collapsed={collapsed} />
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="/"
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Classic UI</span>}
            </a>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right" sideOffset={8}>
              Classic UI
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </aside>
  );
}
