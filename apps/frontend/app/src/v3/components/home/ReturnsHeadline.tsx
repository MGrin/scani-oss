import { formatDate } from '@scani/shared';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ReturnsMoney } from '../../lib/returns';

/**
 * "Up £76,296 since 31 Dec 2025" — the money sentence.
 *
 * The DIRECTION is the word, not the colour: `Up` / `Down` / `Unchanged` reads
 * in greyscale, in forced colours and to a screen reader, which an arrow and a
 * tint do not. The figure is therefore unsigned — `+£76,296` after the word
 * "Up" is the same claim twice — and carries the tone as emphasis only.
 *
 * The period is IN the sentence. A negative number with no window attached is
 * the thing the rates version did wrong at its loudest.
 *
 * ## Why it is a module of its own (SC-1301, SC-1305)
 *
 * It had two mount points for one day — the hero when the Returns tab was on,
 * the card below it when any other tab was — and exactly one rendered at a
 * time. SC-1305 took the hero's, which is now `ReturnsHeroTile`, a stat tile
 * matching the other two tabs; this is the card's sentence and nothing else.
 *
 * **The hazard did not go away with the wording.** The same investment gain is
 * still reachable by two code paths on one screen — this sentence and the
 * hero's figure — and two copies of one number updated by two paths eventually
 * disagree. `returnsTab.test.tsx` counts the FIGURE on the assembled screen
 * and fails at two, which is where it was re-aimed rather than deleted.
 */
export function ReturnsHeadline({
  money,
  currency,
  className,
}: {
  money: ReturnsMoney;
  currency: string;
  className?: string;
}) {
  const direction = money.gain > 0 ? 'up' : money.gain < 0 ? 'down' : 'flat';
  return (
    // `text-balance` rather than a default wrap: at 393px the sentence takes
    // two lines and the greedy break put "since 31" on the first and
    // "Dec 2025" on the second, splitting a date down the middle.
    <p className={cn('text-balance text-label leading-snug', className)}>
      <Trans
        i18nKey={`v3.home.returns.headline.${direction}`}
        values={{ date: formatDate(money.from) }}
        components={{
          amount: (
            <Numeric
              value={Math.abs(money.gain)}
              currency={currency}
              // No pence. At display size they are two thirds of a character
              // cell each and they answer nothing: the exact figure is the
              // attribution list directly underneath.
              decimals={0}
              className={cn(
                'text-display',
                direction === 'up' && 'text-gain',
                direction === 'down' && 'text-loss'
              )}
            />
          ),
        }}
      />
    </p>
  );
}
