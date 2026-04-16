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
}

export function MobileNav({ onMorePress }: MobileNavProps) {
  return (
    <nav
      className="lg:hidden flex items-center justify-around h-14 border-t border-border bg-background shrink-0"
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
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px]',
              isActive ? 'text-primary' : 'text-muted-foreground'
            )
          }
        >
          <item.icon className="h-5 w-5" />
          <span>{item.label}</span>
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMorePress}
        className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px] text-muted-foreground"
      >
        <Menu className="h-5 w-5" />
        <span>More</span>
      </button>
    </nav>
  );
}
