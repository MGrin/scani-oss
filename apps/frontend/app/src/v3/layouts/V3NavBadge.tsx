import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * The count the badge stops spelling out (SC-905).
 *
 * Chosen against the tile rather than by convention, and the two candidates
 * were separated by the icon, not by the tile edge. Measured on this stack in
 * Chromium 148 and WebKit 26.4 — identical to the hundredth of a pixel, because
 * the badge is set in a self-hosted `IBM Plex Sans Variable` whose digits and
 * `+` all carry the same advance, so a cap's width is a function of its GLYPH
 * COUNT and of nothing about the reader's browser:
 *
 *   glyphs   1      2      3      4      5      6      7
 *   16px    19.81  27.61  35.41  43.20  51.00  58.81  66.61
 *
 * The drawer tile is the binding surface — the sidebar has 140px of slack where
 * the tile has 63px, which is the ticket's second question answered — and its
 * worst shipped case is a 280px viewport with the browser's font size set to
 * 24px, where every v3 token is `rem` and scales while the grid stays a
 * fraction of the viewport. There the badge has 70.66px before it leaves the
 * tile:
 *
 *   `99+`   53.11  — clears by 17.55
 *   `999+`  64.81  — clears by  5.85
 *
 * Both fit, so the tile does not decide it. What does: the badge is positioned
 * as a corner badge on the icon (`-end-3 -top-2`), and past `icon + offset`
 * (2.25rem — 36px at a 16px root, 54px at 24px) it reaches beyond the icon's
 * far edge and reads as a bar laid across the tile instead. `99+` is 35.41 and
 * 53.11; `999+` is 43.20 and 64.81. So 99 is the largest cap that stays a
 * badge, and `999+`'s 5.85px is the same knife-edge the uncapped four-digit
 * case already sits on — it would buy almost nothing.
 */
export const NAV_BADGE_CAP = 99;

interface V3NavBadgeProps {
  /** `reviewBadgeCount` — how much is waiting, not how many rows (SC-860). */
  count: number;
  /** Where the surface puts it: `ms-auto` in the sidebar row, absolutely
   *  positioned on the icon in the drawer tile. */
  className?: string;
}

/**
 * The nav badge, on both surfaces that render one as a number.
 *
 * **Capping the pixels must not cap the fact.** The exact count stays the
 * badge's accessible name — a screen reader hears `Review 1234` after this
 * change exactly as it did before it, because the capped string is
 * `aria-hidden` and the true number is carried beside it. That is the whole
 * reason this is two spans rather than one `Math.min`: a `99+` that is also
 * what assistive tech announces would trade a layout bound for a lost fact.
 *
 * For a sighted reader the number is on the home screen, whose `AttentionRow`
 * spells it out in a sentence that wraps, and on `/review` itself. Neither is
 * capped and neither has a width to run out of.
 *
 * The tab bar is deliberately not a caller: it renders a dot, and its count
 * lives in the button's accessible name already.
 */
export function V3NavBadge({ count, className }: V3NavBadgeProps) {
  const { t } = useTranslation();
  if (count <= 0) return null;

  const capped = count > NAV_BADGE_CAP;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-interactive px-1.5 py-0.5 text-caption font-medium leading-none text-interactive-foreground',
        className
      )}
    >
      {/* `cap`, not `count`: an interpolation named `count` puts i18next into
          plural resolution, and this string has no plural — it is a threshold
          being quoted, not a quantity being counted. */}
      <span aria-hidden={capped || undefined}>
        {capped ? t('v3.shell.navBadge.overflow', { cap: NAV_BADGE_CAP }) : count}
      </span>
      {capped && <span className="sr-only">{count}</span>}
    </span>
  );
}
