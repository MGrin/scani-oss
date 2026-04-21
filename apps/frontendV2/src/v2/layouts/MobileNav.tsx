import type { LucideIcon } from 'lucide-react';
import { LayoutDashboard, Menu, PieChart, PlusCircle, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
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

/**
 * iOS PWA softkeyboards shrink the visual viewport while leaving the
 * layout viewport unchanged. That means a `position: fixed` nav pinned
 * to the layout-viewport bottom ends up floating *above* the keyboard,
 * and on dismissal iOS animates the visual viewport back to full height
 * with a brief delay — making the nav appear to "jump up" for a frame
 * or two. Hiding the nav while the keyboard is open sidesteps both
 * problems: users can't see the nav (so no overlap on inputs) and
 * there's nothing to jump.
 *
 * Threshold of 150px covers keyboard heights on every iOS device
 * (~260-340px) while ignoring minor viewport changes like the URL bar
 * collapse in browser tabs.
 */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    const check = () => {
      const heightDiff = window.innerHeight - vv.height;
      setOpen(heightDiff > 150);
    };
    check();
    vv.addEventListener('resize', check);
    vv.addEventListener('scroll', check);
    return () => {
      vv.removeEventListener('resize', check);
      vv.removeEventListener('scroll', check);
    };
  }, []);

  return open;
}

export function MobileNav({ onMorePress, actionRequiredCount = 0 }: MobileNavProps) {
  const hasActionRequired = actionRequiredCount > 0;
  const keyboardOpen = useKeyboardOpen();
  return (
    <nav
      aria-label="Primary"
      aria-hidden={keyboardOpen}
      className={cn(
        'lg:hidden fixed bottom-0 inset-x-0 z-40 flex items-center justify-around h-14 border-t border-border bg-background transition-transform duration-150',
        keyboardOpen && 'translate-y-full pointer-events-none'
      )}
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
