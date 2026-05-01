import type { LucideIcon } from 'lucide-react';
import { LayoutDashboard, Menu, PieChart, PlusCircle, Wallet } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
 * Hide the nav whenever the visual viewport shrinks meaningfully below
 * the layout viewport — i.e. the iOS software keyboard is up (or
 * mid-animation). Trying to float the nav above the keyboard makes it
 * appear to "jump higher than it should" during the multi-hundred-ms
 * dismiss animation, which the user explicitly disliked. So instead of
 * tracking the keyboard, we just slide off until the keyboard is fully
 * down.
 */
function useVisualViewportPin(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    let raf = 0;

    const apply = () => {
      raf = 0;
      // Threshold absorbs the small residual gap iOS reports during
      // URL-bar collapse / minor visual-viewport jitter (typically
      // <30px) without flickering the nav off-screen.
      const gap = window.innerHeight - (vv.offsetTop + vv.height);
      if (gap > 50) {
        nav.style.transform = 'translate3d(0, 100%, 0)';
        nav.style.pointerEvents = 'none';
        nav.setAttribute('aria-hidden', 'true');
      } else {
        nav.style.transform = '';
        nav.style.pointerEvents = '';
        nav.removeAttribute('aria-hidden');
      }
    };

    const schedule = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    // iOS sometimes fires a late window-level resize after the visual
    // viewport has already settled; listen so we catch that tail event
    // and re-sync the transform.
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
    };
  }, [ref]);
}

export function MobileNav({ onMorePress, actionRequiredCount = 0 }: MobileNavProps) {
  const hasActionRequired = actionRequiredCount > 0;
  const navRef = useRef<HTMLElement | null>(null);
  useVisualViewportPin(navRef);
  return (
    <nav
      ref={navRef}
      aria-label="Primary"
      className={cn(
        'lg:hidden fixed bottom-0 inset-x-0 z-40 flex items-center justify-around h-14 border-t border-border bg-background transition-transform duration-150 will-change-transform'
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
