import { ThemeToggle } from '@scani/ui/components/ThemeToggle';
import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerDescription,
  BottomDrawerHeader,
  BottomDrawerTitle,
} from '@scani/ui/ui/bottom-drawer';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { navIcon } from '../lib/nav-icons';
import { V3_DRAWER_PRIMARY, V3_DRAWER_SECONDARY, V3_ROUTES } from '../lib/routes';

interface V3MoreDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activePath: string | null;
  actionRequiredCount?: number;
  onSignOut: () => void;
}

/**
 * Everything the five tab slots could not hold.
 *
 * It rests at 40% and grows to full on a drag, which is the shape that
 * lets the six most-used destinations be a grid rather than the head of a
 * scrolling list. v2's version listed all thirteen sidebar entries, which
 * pushed the badged Review item below the fold and required
 * `AppShell.tsx:71-79` to scroll it back into view. Review is the first
 * cell of the grid here, so there is nothing to scroll to.
 *
 * No `min-h-tap` on the rows — see the note in `DataRow.tsx`. The drawer is
 * mounted by the shell at every width, so a hard 44px here is a desktop row
 * height, not a hit area; under `pointer: coarse` the token layer supplies it.
 *
 * Since SC-67 the drawer is `?sheet=more` on whatever screen raised it, so the
 * back gesture closes it rather than navigating the page behind it. Every row
 * therefore navigates with `replace`: the drawer is a step on the way to a
 * destination, and Back out of that destination should reach the screen the
 * user started on, not raise the drawer again.
 */
export function V3MoreDrawer({
  open,
  onOpenChange,
  activePath,
  actionRequiredCount = 0,
  onSignOut,
}: V3MoreDrawerProps) {
  const { t } = useTranslation();
  const close = () => onOpenChange(false);

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        // The portal container comes from `V3TokenScope` on the shell root.
        // Without it the drawer lands on <body>, outside `data-ui="v3"`, and
        // renders against v2's tokens — plausibly enough not to look broken.
        snapPoints={[0.4, 1]}
      >
        <BottomDrawerHeader>
          <BottomDrawerTitle>{t('nav.more')}</BottomDrawerTitle>
          <BottomDrawerDescription className="sr-only">
            {t('v3.shell.moreDrawer.description')}
          </BottomDrawerDescription>
        </BottomDrawerHeader>

        <BottomDrawerBody>
          <ul className="grid grid-cols-3 gap-2">
            {V3_DRAWER_PRIMARY.map((item) => {
              const Icon = navIcon(item.icon);
              const badge = item.path === V3_ROUTES.review ? actionRequiredCount : 0;
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    replace
                    aria-current={item.path === activePath ? 'page' : undefined}
                    className={cn(
                      'flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface-1 px-2 py-4 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      item.path === activePath
                        ? 'border-interactive text-interactive'
                        : 'text-foreground'
                    )}
                  >
                    <span className="relative inline-flex">
                      <Icon className="h-6 w-6" aria-hidden="true" />
                      {badge > 0 && (
                        <span className="absolute -right-3 -top-2 inline-flex items-center justify-center rounded-full bg-interactive px-1.5 py-0.5 text-caption font-medium leading-none text-interactive-foreground">
                          {badge}
                        </span>
                      )}
                    </span>
                    <span className="text-caption">{t(item.labelKey)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <ul className="mt-4 space-y-1">
            {V3_DRAWER_SECONDARY.map((item) => {
              const Icon = navIcon(item.icon);
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    replace
                    aria-current={item.path === activePath ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      item.path === activePath
                        ? 'bg-surface-hover text-interactive'
                        : 'text-muted-foreground'
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span>{t(item.labelKey)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <div
            className="mt-4 space-y-1 border-t border-border pt-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--space-4))' }}
          >
            <ThemeToggle variant="row" side="top" align="start" className="px-3 py-2 text-label" />
            <button
              type="button"
              onClick={() => {
                close();
                onSignOut();
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-label text-loss focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{t('nav.signOut')}</span>
            </button>
          </div>
        </BottomDrawerBody>
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
