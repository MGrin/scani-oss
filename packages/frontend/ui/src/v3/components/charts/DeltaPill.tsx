import { cn } from '../../../lib/cn';
import { type NumericTone, resolveNumeric } from '../../lib/numeric';
import { Numeric } from '../Numeric';

/**
 * A change, as a chip. The figure itself is `<Numeric delta>` (V3-07) — this
 * adds only the tinted enclosure and the period it is measured against, which
 * is the whole difference between "+2.4%" floating beside a number and a delta
 * that reads as one object attached to it.
 *
 * The tint is the tone at 15% over the card. Every combination clears 4.5:1
 * against its own text in both themes (worst case 4.68:1, loss on light), and
 * the wash is deliberately weak: it is there to bound the chip, not to encode
 * anything. Direction is carried by the sign and the arrow inside, so the
 * whole pill still works in greyscale.
 *
 * The period sits *outside* the tint in muted ink rather than inside it. Text
 * wears text tokens; the coloured area belongs to the figure.
 */

const TONE_FILL: Record<NumericTone, string> = {
  gain: 'bg-gain/15',
  loss: 'bg-loss/15',
  neutral: 'bg-neutral/15',
};

interface DeltaPillProps {
  value: number | string | null | undefined;
  /** Required for the default `currency` format. */
  currency?: string;
  format?: 'currency' | 'percent' | 'plain';
  decimals?: number;
  compact?: boolean;
  /** Named period the change is measured over, e.g. `30d` → "vs 30d". */
  period?: string;
  className?: string;
}

export function DeltaPill({
  value,
  currency,
  format = 'currency',
  decimals,
  compact,
  period,
  className,
}: DeltaPillProps) {
  // Resolved twice — here for the tint and inside `<Numeric>` for the text —
  // rather than reaching into Numeric's internals or duplicating the sign
  // rules. `resolveNumeric` is pure and cheap, and one source of truth for
  // "which way did this go" matters more than one call.
  const { tone, isPlaceholder } = resolveNumeric(value, {
    format,
    currency,
    decimals,
    compact,
    delta: true,
  });

  const numeric =
    format === 'currency' ? (
      <Numeric
        value={value}
        currency={currency ?? 'USD'}
        decimals={decimals}
        compact={compact}
        delta
      />
    ) : (
      <Numeric value={value} format={format} decimals={decimals} delta />
    );

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-caption',
          // An unknown value gets no tint: a grey chip around "—" would assert
          // that nothing changed, which is a different claim from not knowing.
          isPlaceholder ? 'text-muted-foreground' : TONE_FILL[tone ?? 'neutral']
        )}
      >
        {numeric}
      </span>
      {period ? <span className="text-caption text-muted-foreground">vs {period}</span> : null}
    </span>
  );
}
