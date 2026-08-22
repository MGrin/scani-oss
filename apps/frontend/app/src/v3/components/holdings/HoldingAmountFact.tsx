import { Button } from '@scani/ui/ui/button';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { amountDecimals } from '../../lib/holdings';
import { LookalikeBadge } from './LookalikeBadge';

/**
 * The unit count, editable in place.
 *
 * v2 puts this behind a pencil beside a headline figure on the detail page;
 * here it is a fact in the peek sheet, which is where the twelve fields that
 * left the row went. The interaction is the same one and deliberately so — the
 * balance of a manually-tracked holding is the single field people correct
 * most often, and routing it through a form would make the common case the
 * long way round.
 *
 * The input is `text-body` (16px) rather than the shared `Input`'s `text-sm`:
 * iOS zooms the page on focusing anything under 16px, and a sheet that jumps
 * when you tap its one input reads as broken without ever being filed as a bug.
 */

interface HoldingAmountFactProps {
  amount: number;
  /**
   * What the count counts (SC-559).
   *
   * The fact rendered a bare number and named its unit nowhere — the reader
   * recovered "which token is this" from the sheet's title or not at all, and
   * mgrin reported that from production. The symbol is not a decoration on the
   * figure; without it the figure is not a quantity.
   */
  symbol: string;
  /**
   * The symbol this one draws, when it draws somebody else's.
   *
   * Printing the symbol here is the thing `holdingsConfig` warns about: a bare
   * `UЅDС` beside a number is indistinguishable from `USDC` and carries no
   * warning of its own. The list badges the symbol in the row's identity zone;
   * this sheet had no badge anywhere, so the unit brings its own.
   */
  lookalikeOf?: string | null;
  /** Applied optimistically by `optimisticPatchHolding`, so the row and this
   *  fact both move before the server answers. */
  onSave: (balance: string) => void;
}

export function HoldingAmountFact({ amount, symbol, lookalikeOf, onSave }: HoldingAmountFactProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <span className="flex min-w-0 items-center justify-end gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <Numeric value={amount} format="plain" decimals={amountDecimals(amount)} />
          <span className="truncate">{symbol}</span>
        </span>
        {lookalikeOf ? <LookalikeBadge symbol={symbol} impersonates={lookalikeOf} t={t} /> : null}
        <button
          type="button"
          onClick={() => setDraft(String(amount))}
          aria-label={t('v3.holdings.amountFact.edit')}
          className="-my-1 rounded-md p-1 text-muted-foreground transition-colors duration-fast ease-emphasized hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="size-4" aria-hidden="true" />
        </button>
      </span>
    );
  }

  const commit = () => {
    const next = draft.trim();
    if (next) onSave(next);
    setDraft(null);
  };

  return (
    <span className="flex items-center justify-end gap-2">
      <AmountInput
        value={draft}
        onValueChange={setDraft}
        className="h-9 w-32 text-right text-body"
        decimalScale={8}
        aria-label={t('v3.holdings.amountFact.amount')}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(null);
        }}
      />
      <Button size="sm" onClick={commit}>
        {t('v3.holdings.amountFact.save')}
      </Button>
    </span>
  );
}
