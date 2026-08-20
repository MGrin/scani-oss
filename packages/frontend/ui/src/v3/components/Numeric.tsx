import type { ComponentPropsWithoutRef } from 'react';
import { useUiTranslation } from '../../i18n';
import { cn } from '../../lib/cn';
import { figureCells, figureFitStyle } from '../lib/figure';
import { type NumericFormat, type NumericTone, resolveNumeric } from '../lib/numeric';

/**
 * Every figure in v3. Owns currency formatting, `tabular-nums`, the sign, the
 * gain/loss token and — for a delta — the arrow that carries the direction
 * without colour.
 *
 * It exists because v2 applied `tabular-nums` in 46 places by hand and encoded
 * gain/loss with `text-green-600` / `text-red-600` in 47, which is why neither
 * is universal: both were applied by whoever remembered. A figure in v3 is not
 * a `<span>` with utilities on it.
 *
 * Two rules the component enforces so no call site has to:
 *
 * - **Colour is never the only signal.** A delta always carries `+`/`−`, and by
 *   default an arrow too (§5.1 rule 2 of the design brief). `indicator="sign"`
 *   drops the arrow for dense columns; nothing drops the sign.
 * - **A magnitude is not a delta.** `<Numeric value={-500} …/>` renders
 *   `−$500.00` in the inherited colour: an account can hold a negative balance
 *   without that being a loss. Pass `delta` when the figure *is* a change.
 *
 * Size is inherited — the `numeric` type role is a treatment, not a size, so
 * the caller sets `text-display` / `text-label` / `text-caption` and this adds
 * the face, the figure widths and the tracking.
 */

/** The `numeric` role from §5.2: monospaced, tabular, its own tracking. */
const NUMERIC_ROLE = 'font-mono tabular-nums tracking-numeric';

const TONE_CLASS: Record<NumericTone, string> = {
  gain: 'text-gain',
  loss: 'text-loss',
  neutral: 'text-neutral',
};

interface NumericBaseProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  value: number | string | null | undefined;
  decimals?: number;
  /** Compact notation ("$1.2K"). `currency` format only. */
  compact?: boolean;
  /** A change rather than a magnitude: signed, toned, and carrying an arrow. */
  delta?: boolean;
  /** `both` (default) is sign + arrow; `sign` drops the arrow, never the sign. */
  indicator?: 'both' | 'sign';
}

/** `currency` is required for the currency format and rejected for the others,
 *  which is a compile error rather than a `$` in front of a percentage. */
export type NumericProps =
  | (NumericBaseProps & { format?: 'currency'; currency: string })
  | (NumericBaseProps & { format: Exclude<NumericFormat, 'currency'>; currency?: undefined });

export function Numeric({
  value,
  format = 'currency',
  currency,
  decimals,
  compact = false,
  delta = false,
  indicator = 'both',
  className,
  ...rest
}: NumericProps) {
  const { t } = useUiTranslation();
  const parts = resolveNumeric(value, { format, currency, decimals, compact, delta });

  if (parts.isPlaceholder) {
    return (
      <span className={cn(NUMERIC_ROLE, 'text-muted-foreground', className)} {...rest}>
        {/* An em dash alone is announced as nothing by most screen readers, so
            the absence of a value has to be said in words. */}
        <span aria-hidden="true">{parts.magnitude}</span>
        <span className="sr-only">{t('ui.numeric.noValue')}</span>
      </span>
    );
  }

  const showArrow = indicator === 'both' && parts.arrow !== '';
  const run = showArrow ? `${parts.arrow} ${parts.text}` : parts.text;

  return (
    <span className={cn(NUMERIC_ROLE, parts.tone && TONE_CLASS[parts.tone], className)} {...rest}>
      {/* The fit lives on an inner span so that `1em` in the size rule still
          resolves to the size the *caller* asked for: `text-display` and the
          tone stay outside, and fitting is a reduction from the type role
          rather than a replacement for it. See `lib/figure.ts`. */}
      <span data-figure-fit="true" style={figureFitStyle(figureCells(run))}>
        {/* Hidden from assistive tech because `parts.text` already carries the
            direction as a sign. A thin space rather than a margin: it keeps the
            arrow inside the text run, where it cannot shift the digit grid. */}
        {showArrow ? <span aria-hidden="true">{`${parts.arrow} `}</span> : null}
        {parts.text}
      </span>
    </span>
  );
}
