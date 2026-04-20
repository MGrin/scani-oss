import type { LucideIcon } from 'lucide-react';
import { LayoutDashboard, Menu, PieChart, PlusCircle, Wallet } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { V2_ROUTES } from '../lib/routes';

interface MobileNavItem {
  label: string;
  icon: LucideIcon;
  path: string;
  end?: boolean;
}

const items: MobileNavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: V2_ROUTES.dashboard, end: true },
  { label: 'Holdings', icon: PieChart, path: V2_ROUTES.holdings },
  { label: 'Add', icon: PlusCircle, path: V2_ROUTES.addData },
  { label: 'Accounts', icon: Wallet, path: V2_ROUTES.accounts },
];

interface MobileNavProps {
  onMorePress: () => void;
  /** When > 0, renders an amber dot over the More button to signal jobs awaiting review. */
  actionRequiredCount?: number;
}

export function MobileNav({ onMorePress, actionRequiredCount = 0 }: MobileNavProps) {
  const hasActionRequired = actionRequiredCount > 0;
  return (
    <nav
      aria-label="Primary"
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 flex items-center justify-around h-14 border-t border-border bg-background"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        height: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.end}
          aria-label={item.label}
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px]',
              isActive ? 'text-primary' : 'text-muted-foreground'
            )
          }
        >
          <item.icon className="h-5 w-5" aria-hidden="true" />
          <span>{item.label}</span>
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMorePress}
        aria-label={
          hasActionRequired
            ? `More — ${actionRequiredCount} job${actionRequiredCount === 1 ? '' : 's'} need review`
            : 'More'
        }
        className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px] text-muted-foreground"
      >
        <span className="relative inline-flex">
          <Menu className="h-5 w-5" aria-hidden="true" />
          {hasActionRequired && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background"
            />
          )}
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}
