import { Block } from '@scani/ui/v3/components/Block';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { AllocationInput } from '@scani/ui/v3/lib/chart';
import { AllocationBar } from '../charts/AllocationBar';

/**
 * What a list of containers adds up to, over the rows actually shown.
 *
 * Same contract as `HoldingsSummary` and for the same reason: it is a `summary`
 * on the data view, so it receives the **filtered** set. Filtering to one
 * institution and reading the whole-portfolio total underneath it is a wrong
 * number on the screen, and the count line directly below already says "3 of 12
 * accounts", so there is no ambiguity about what is being added up.
 *
 * The label is the plain noun — "Value", not "Total value" — because it is the
 * value of *these*, not a claim about everything.
 *
 * The bar is suppressed below two segments: a stacked bar with one part is a
 * full-width rectangle encoding nothing, above a list entry repeating the
 * figure that is already directly above it.
 */

interface EntityValueSummaryProps {
  value: number;
  currency: string;
  allocation: readonly AllocationInput[];
  /** Names the bar for assistive tech — "Value by account". */
  allocationLabel: string;
}

export function EntityValueSummary({
  value,
  currency,
  allocation,
  allocationLabel,
}: EntityValueSummaryProps) {
  const parts = allocation.filter((item) => item.value > 0);

  return (
    <Block className="flex flex-col gap-4 p-4">
      <StatTile
        emphasis="hero"
        label="Value"
        value={<Numeric value={value} currency={currency} />}
      />
      {parts.length > 1 ? (
        <AllocationBar items={parts} currency={currency} label={allocationLabel} />
      ) : null}
    </Block>
  );
}
