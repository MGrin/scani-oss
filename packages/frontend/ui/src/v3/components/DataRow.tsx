import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { TruncatedText } from './TruncatedText';

/**
 * The three-zone row from §2.2 of the research brief, and the list that holds
 * a run of them.
 *
 * The zones are **identity** (left, truncates), **value** (right, never
 * truncates) and **delta** (right, under the value). That is the whole row.
 * `HoldingCard.tsx` puts fifteen data points in one card at `text-xs` and
 * `text-[9px]`; the fix for a phone is subtraction, and the props here are the
 * subtraction made structural — there is no slot for the twelfth field, which
 * goes to the peek sheet (V3-11) instead.
 *
 * The value zone never truncating is the load-bearing part: a truncated figure
 * is worse than no figure, so the identity column is the one that gives way.
 * `minmax(0,1fr)` on identity plus `whitespace-nowrap` on value is what does
 * it — `truncate` alone inside a grid child will not shrink below its content
 * without the explicit `min-width: 0`.
 *
 * Per §4.3, a run of rows is **one surface with hairlines in it** — no card per
 * row, no gap, no shadow. That removes roughly 12px of chrome per row, which is
 * one more holding per phone screen.
 */

interface DataRowProps {
  /** Zone 1. Truncates unless `wrapIdentity`. */
  label: ReactNode;
  /** One secondary identity line. Truncates unless `wrapIdentity`. */
  sublabel?: ReactNode;
  /**
   * Let the identity zone take the height it needs instead of clipping (SC-200).
   *
   * Opt-in, because clipping is right for the usual case and this is not it. A
   * clipped **name** is still recognisable — "Orbital Systems Ltd · JPMorgan
   * Cha…" is the row you were looking for, and `TruncatedText` hands back the
   * rest on hover. A clipped **sentence** is not: the data-quality panel showed
   * "Shown positions with no recent pri…" and "An import that did not reach
   * back bef…", where the ending carries the whole meaning and there is no
   * hover on a phone to recover it.
   *
   * The row's contract is unchanged — the value zone still never gives way.
   * This only changes *how* identity gives way: by height rather than by width.
   */
  wrapIdentity?: boolean;
  /** Fixed-width slot before the identity: favicon, avatar, selection box. */
  leading?: ReactNode;
  /** Zone 2. Never truncates. A `<Numeric>` in almost every case. */
  value: ReactNode;
  /** Zone 3, under the value. A `<Numeric delta>` in almost every case. */
  delta?: ReactNode;
  /**
   * Where the row's record lives. Preferred over `onClick` whenever the
   * destination is a URL: a link is the only control that can be opened in a
   * new tab, copied, previewed on hover and read out by a screen reader as
   * "link", and `navigate()` behind a `<button>` throws all of that away to
   * arrive at the same place. Takes precedence when both are given.
   */
  href?: string;
  /**
   * History state to push with `href`.
   *
   * The one caller that needs it is a row linking to another surface's **peek**:
   * `resolvePeekClose` pops rather than replaces only when it recognises
   * `peekOpenState(basePath)` here, and without it dismissing the sheet lands
   * the reader on that surface's list instead of returning to the screen the
   * row was on.
   */
  linkState?: unknown;
  /** Makes the whole row the tap target that opens the record. For a row whose
   *  destination is *not* a URL — a peek this list owns, a selection toggle. */
  onClick?: () => void;
  /** Required when `onClick` is set and `label` is not a plain string. */
  'aria-label'?: string;
  /** For a row that toggles rather than opens — selection mode. The row is a
   *  toggle button there, and without this the only cue that it is on is the
   *  16px box drawn in `leading`, which is `aria-hidden`. */
  'aria-pressed'?: boolean;
  /**
   * A second control, beside the row's own rather than inside it (SC-560).
   *
   * The row is a single `<button>` or `<a>`, so nothing tappable can be nested
   * in it — that is HTML, not a policy. This renders as the control's SIBLING
   * inside the `<li>`, which is the only place a second target can legally go.
   *
   * Used where a record has two destinations of genuinely different weight:
   * the accounts row leads to that account's holdings, which is what a reader
   * wants nine times in ten, and this opens the account's own record, which is
   * the tenth. It is deliberately narrow and deliberately not the row — a
   * second target the width of the first is two rows pretending to be one.
   *
   * Never rendered while selecting: there the row means "toggle me" and a
   * mis-tap that navigated out of a half-made selection is exactly what
   * `DataViewRows` explains the selection idiom to avoid.
   */
  trailing?: ReactNode;
  className?: string;
}

/**
 * No `min-h-tap` here on purpose. V3-23 neutralised the unscoped 44px
 * `min-height` inside v3 and re-applies it behind `pointer: coarse`, because
 * applied at every pointer type it stops being a hit area and becomes a row
 * height — which is most of "everything feels too large". So a tappable row
 * gets its 44px from the token layer matching `button` under a coarse pointer,
 * and on a mouse the row is as tall as its content and padding make it.
 *
 * `min-h-tap` would not put the unconditional 44px back — V3-25 measured it —
 * but it would not add anything either: the neutraliser's
 * `[data-ui='v3'] :is(button, a, …)` is (0,2,1) against a utility class's
 * (0,1,0), and Tailwind's `@layer` directive flattens both into the same
 * unlayered output, so specificity decides and the token rule wins. On a
 * non-control (a `div`) nothing neutralises it and it *is* an unconditional
 * row height. Either way the class is the wrong tool; padding is the right one.
 */
const ZONES = 'grid items-center gap-3 px-4 py-2 text-left';

/**
 * The row is the figure's line (SC-72), not the value zone — the value zone is
 * an `auto` track, so its width comes *from* the figure and a budget read off
 * it would be the figure's own width fed back to it. Sizing the figure against
 * the row instead is the same rule the zones already follow: the value never
 * gives way, the identity column does, and past the point where identity has
 * given up its last pixel the figure shrinks rather than take the row wider
 * than the screen.
 */
const FIGURE_LINE = { 'data-figure-line': 'true' } as const;

/**
 * What a row looks like once it is a control, shared by both branches so a
 * link and a button are indistinguishable to the eye and to the finger.
 *
 * `--surface-hover`, not `--surface-2`: on the white light page (V3-23)
 * surface-2 *is* white, so a hover fill has to go down.
 *
 * The focus ring is inset rather than the house 2px offset — a full-bleed row
 * has no margin to draw an outer ring into, so an offset ring would be clipped
 * by the neighbouring rows.
 */
const CONTROL =
  'w-full transition-colors duration-fast ease-emphasized ' +
  'hover:bg-surface-hover active:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

export function DataRow({
  label,
  sublabel,
  wrapIdentity,
  leading,
  value,
  delta,
  href,
  linkState,
  onClick,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
  trailing,
  className,
}: DataRowProps) {
  // Two literal templates rather than one with a collapsing `auto` column: an
  // empty leading track still pays the `gap-3` between it and the identity.
  const columns = leading
    ? 'grid-cols-[auto_minmax(0,1fr)_auto]'
    : 'grid-cols-[minmax(0,1fr)_auto]';

  // `text-pretty` rather than a bare wrap: these are sentences, and a last line
  // holding one word is the shape that reads as a rendering fault.
  const identityLine = wrapIdentity ? 'text-pretty' : 'truncate';

  const zones = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="min-w-0">
        {/* Both identity lines offer their full text on hover once the zone
            has cut them short (SC-114) — home's Top holdings reads
            "Orbital Systems Ltd · JPMorgan Cha…" and the rest of it was
            reachable nowhere in the product. Under `wrapIdentity` nothing is
            cut, so `useOverflowTitle` measures no overflow and adds no
            attribute; the component stays for the surfaces that do clip. */}
        {/* Class order matches the pre-SC-200 output exactly — `block`, then
            the clip/wrap utility, then the type. `money.test.tsx` asserts on
            the rendered class string, so a reorder that changes nothing about
            the CSS still fails it. */}
        <TruncatedText className={cn('block', identityLine, 'text-label')}>{label}</TruncatedText>
        {sublabel ? (
          <TruncatedText
            className={cn('block', identityLine, 'text-caption text-muted-foreground')}
          >
            {sublabel}
          </TruncatedText>
        ) : null}
      </span>
      <span
        className={cn(
          'flex flex-col items-end whitespace-nowrap',
          // A wrapped identity can be three lines tall; centring the figure
          // against it floats it in the middle of a paragraph it belongs to
          // the top of. Only for the wrapping case — every clipped row is one
          // line and centring is what pairs the figure with it.
          wrapIdentity ? 'self-start' : undefined
        )}
      >
        <span className="text-label">{value}</span>
        {delta ? <span className="text-caption">{delta}</span> : null}
      </span>
    </>
  );

  // `min-w-0` on the control so it still gives up width to the trailing
  // control rather than overflowing the row — the same reason the identity
  // zone carries it. Without `trailing` this is one child and the wrapper is
  // inert, which is why it costs the rows that do not use it nothing.
  const row = (control: ReactNode) =>
    trailing ? (
      <span className="flex items-stretch">
        <span className="min-w-0 flex-1">{control}</span>
        {/* `pr-2` rather than the row's own `px-4`: the control has its own
            padding and a second full gutter would push it off a 393px row. */}
        <span className="flex shrink-0 items-center pr-2">{trailing}</span>
      </span>
    ) : (
      control
    );

  if (href) {
    return (
      <li className={className}>
        {row(
          <Link
            to={href}
            state={linkState}
            {...FIGURE_LINE}
            aria-label={ariaLabel}
            className={cn(ZONES, columns, CONTROL)}
          >
            {zones}
          </Link>
        )}
      </li>
    );
  }

  return (
    <li className={className}>
      {row(
        onClick ? (
          <button
            type="button"
            {...FIGURE_LINE}
            onClick={onClick}
            aria-label={ariaLabel}
            aria-pressed={ariaPressed}
            className={cn(ZONES, columns, CONTROL)}
          >
            {zones}
          </button>
        ) : (
          <div {...FIGURE_LINE} className={cn(ZONES, columns)}>
            {zones}
          </div>
        )
      )}
    </li>
  );
}

/**
 * The surface a run of rows sits on. Owns the hairlines, so no row draws its
 * own edge and a 200-row list has 199 rules rather than 200 boxes.
 *
 * Full-strength `--border` is correct here: since V3-23 that token *is* the
 * decorative hairline, held to no contrast floor, and `--border-strong` is the
 * separate one for control edges that owe WCAG 1.4.11.
 */
export function DataRowList({ className, ...rest }: ComponentPropsWithoutRef<'ul'>) {
  return (
    <ul
      className={cn(
        'divide-y divide-border',
        // Rows scrolled into view by the browser — Tab, a restored position,
        // any `scrollIntoView` — stop below the sticky toolbar rather than
        // under it. `useStickyOffset` publishes the height; the fallback of 0
        // is correct for every list with no sticky chrome above it (SC-71 8.4).
        '[&>li]:scroll-mt-[var(--v3-list-sticky,0px)]',
        className
      )}
      {...rest}
    />
  );
}
