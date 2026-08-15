import type { LucideIcon } from 'lucide-react';
import { CalendarClock, LayoutDashboard, Menu, PlusCircle, Wallet } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { useVisualViewportPin } from '@/hooks/useVisualViewportPin';
import { cn } from '@/lib/utils';
import { V2_ROUTES } from '../lib/routes';

interface MobileNavItem {
  labelKey: string;
  icon: LucideIcon;
  path: string;
  end?: boolean;
}

const items: MobileNavItem[] = [
  { labelKey: 'nav.dashboard', icon: LayoutDashboard, path: V2_ROUTES.dashboard, end: true },
  // Deliberately NOT `end`: a bottom tab represents a SECTION, so it stays
  // lit on /payments/recurring and a payment's own page. That is the
  // opposite of the sidebar, where /payments and /payments/recurring are
  // two separate entries and only the most specific one may light.
  { labelKey: 'nav.payments', icon: CalendarClock, path: V2_ROUTES.payments },
  { labelKey: 'nav.add', icon: PlusCircle, path: V2_ROUTES.addData },
  { labelKey: 'nav.accounts', icon: Wallet, path: V2_ROUTES.accounts },
];

interface MobileNavProps {
  onMorePress: () => void;
  /** When > 0, renders an amber dot over the More button to signal jobs awaiting review. */
  actionRequiredCount?: number;
}

export function MobileNav({ onMorePress, actionRequiredCount = 0 }: MobileNavProps) {
  const hasActionRequired = actionRequiredCount > 0;
  const navRef = useRef<HTMLElement | null>(null);
  useVisualViewportPin(navRef);
  const { t } = useTranslation();
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
      {items.map((item) => {
        const label = t(item.labelKey);
        return (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.end}
            aria-label={label}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px]',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )
            }
          >
            <item.icon className="h-5 w-5" aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        );
      })}
      <button
        type="button"
        onClick={onMorePress}
        aria-label={
          hasActionRequired
            ? `${t('nav.more')} — ${actionRequiredCount} job${actionRequiredCount === 1 ? '' : 's'} need review`
            : t('nav.more')
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
        <span>{t('nav.more')}</span>
      </button>
    </nav>
  );
}
