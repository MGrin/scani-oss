import { Button } from '@scani/ui/ui/button';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { amountDecimals } from '../../lib/holdings';

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
  /** Applied optimistically by `optimisticPatchHolding`, so the row and this
   *  fact both move before the server answers. */
  onSave: (balance: string) => void;
}

export function HoldingAmountFact({ amount, onSave }: HoldingAmountFactProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <span className="flex items-center justify-end gap-2">
        <Numeric value={amount} format="plain" decimals={amountDecimals(amount)} />
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
