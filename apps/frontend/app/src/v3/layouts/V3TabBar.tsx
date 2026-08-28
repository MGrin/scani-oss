import { Menu } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useVisualViewportPin } from '@/hooks/useVisualViewportPin';
import { cn } from '@/lib/utils';
import { navIcon } from '../lib/nav-icons';
import { V3_TAB_ITEMS } from '../lib/routes';

interface V3TabBarProps {
  /** Result of `resolveActiveTabPath` — null on a screen that belongs to no
   * tab, which correctly leaves the whole bar unlit. */
  activeTabPath: string | null;
  onCapturePress: () => void;
  onMorePress: () => void;
  /** When > 0, marks More with a dot: something behind it needs the user. */
  actionRequiredCount?: number;
}

/** Every slot is at least `--tap-target` (44px) in both axes. The bar is
 * 56px tall so the icon-over-label stack fits inside that floor rather
 * than pushing against it, and each slot is `flex-1` of a phone's width,
 * so the horizontal floor is never the binding constraint either. */
const BAR_HEIGHT = '3.5rem';

/** Every slot reserves the same 28px band for its glyph, so the five labels
 * share one baseline. Without it the centre action's filled pill is taller
 * than a bare icon and drags its own label down past the bar's edge. */
const GLYPH_BAND = 'h-7';

/** No `min-h-tap` / `min-w-tap`, even though this is the one surface that is
 * only ever touched. Inside `[data-ui='v3']` those utilities are inert:
 * V3-23's `[data-ui='v3'] :is(button, a, …)` neutraliser is (0,2,1) against a
 * utility class's (0,1,0), and Tailwind's `@layer` directive flattens both
 * into the same unlayered output, so specificity — not layer order — decides.
 * Measured: a slot carrying `min-h-tap` computed `min-height: 0px` under
 * `pointer: fine` and 44px under `pointer: coarse`, which is precisely what it
 * computes without the class. The hit area is real regardless — `BAR_HEIGHT`
 * gives every slot 56px and `flex-1` gives it a fifth of the viewport. */
const SLOT = 'flex flex-1 flex-col items-center justify-center gap-1 focus-visible:outline-none';

/**
 * The five-slot bar. `Link` rather than `NavLink` because which tab is lit
 * is decided by `resolveActiveTabPath` — a tab stands for a section, and
 * `NavLink`'s own matching cannot express "lit on descendants, but only
 * the most specific tab".
 */
export function V3TabBar({
  activeTabPath,
  onCapturePress,
  onMorePress,
  actionRequiredCount = 0,
}: V3TabBarProps) {
  const navRef = useRef<HTMLElement | null>(null);
  useVisualViewportPin(navRef);
  const { t } = useTranslation();
  const hasActionRequired = actionRequiredCount > 0;

  return (
    <nav
      ref={navRef}
      aria-label={t('v3.shell.tabBar.landmark')}
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-surface-1 lg:hidden"
      style={{
        height: `calc(${BAR_HEIGHT} + env(safe-area-inset-bottom, 0px))`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        transition: 'transform var(--motion-fast) var(--motion-ease)',
        willChange: 'transform',
      }}
    >
      {V3_TAB_ITEMS.map((item) => {
        const Icon = navIcon(item.icon);
        const label = t(item.labelKey);
        const isActive = item.path !== undefined && item.path === activeTabPath;

        if (item.emphasis === 'action' || item.path === undefined) {
          // Capture is the highest-frequency write in a tracker, so it gets
          // the distinguished centre slot rather than a tab that looks like a
          // destination — and it behaves like one too: a button opening a
          // sheet over the current screen, so choosing how to add data never
          // costs the user the screen they were reading.
          return (
            <button
              key={item.labelKey}
              type="button"
              onClick={onCapturePress}
              aria-label={label}
              className={cn(
                SLOT,
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
              )}
            >
              <span
                className={cn(
                  GLYPH_BAND,
                  'flex w-12 items-center justify-center rounded-md bg-interactive text-interactive-foreground'
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="text-caption leading-none text-muted-foreground">{label}</span>
            </button>
          );
        }

        return (
          <Link
            key={item.path}
            to={item.path}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              SLOT,
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              isActive ? 'text-interactive' : 'text-muted-foreground'
            )}
          >
            <span className={cn(GLYPH_BAND, 'flex items-center')}>
              <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={isActive ? 2.4 : 2} />
            </span>
            <span className="text-caption leading-none">{label}</span>
          </Link>
        );
      })}

      <button
        type="button"
        onClick={onMorePress}
        // One interpolated, pluralised key rather than a sentence assembled
        // from three fragments (SC-201). The English happened to need only
        // "needs"/"need"; a language with six plural forms cannot be served by
        // a ternary, and the concatenation order is not universal either.
        aria-label={
          hasActionRequired
            ? t('v3.shell.tabBar.moreWithReview', { count: actionRequiredCount })
            : t('nav.more')
        }
        className={cn(
          SLOT,
          'text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
        )}
      >
        <span className={cn(GLYPH_BAND, 'relative inline-flex items-center')}>
          <Menu className="h-5 w-5" aria-hidden="true" />
          {hasActionRequired && (
            // The accent, not `--loss`: an item waiting to be reviewed is
            // something to look at, not something that has gone wrong. The
            // count is in the button's accessible name, so the dot is never
            // the only carrier of the signal.
            <span
              aria-hidden="true"
              className="absolute -end-1 -top-1 h-2 w-2 rounded-full bg-interactive ring-2 ring-surface-1"
            />
          )}
        </span>
        <span className="text-caption leading-none">{t('nav.more')}</span>
      </button>
    </nav>
  );
}

/** Height the scroll container must reserve so the bar never covers the
 * last row of content. Exported so the shell and the bar cannot disagree. */
export const V3_TAB_BAR_SPACER = `calc(${BAR_HEIGHT} + env(safe-area-inset-bottom, 0px))`;
