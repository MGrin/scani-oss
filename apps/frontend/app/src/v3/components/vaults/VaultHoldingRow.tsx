import { Button } from '@scani/ui/ui/button';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Check, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  attributedValue,
  isValidVaultPercentage,
  type VaultHoldingRow as VaultHoldingRowData,
} from '../../lib/vaults';

/**
 * One holding attached to a vault, with its share of that holding editable in
 * place.
 *
 * Not a `<DataRow>`. The three-zone row is a *link* to a record; this is a
 * record with two controls on it, and the percentage control has an editing
 * state that a row signature with no slot for it cannot carry. So this is its
 * own shape, sitting on the same `divide-y` surface, which is what keeps the
 * list reading as one thing.
 *
 * The editing state is local to the row rather than lifted to the screen: v2
 * holds `editingPercentage` and `percentageInput` on the page, which is two
 * pieces of state that have to be kept in step and a second row that inherits
 * the first one's text if the id changes while the input is open.
 *
 * `Remove` confirms since SC-73. It used to detach on the tap, eight pixels
 * from the pencil that opens the percentage editor — the two things a reader
 * does to this row are "adjust the share" and "take it out", and only one of
 * them was reversible by pressing the same button again. The row is a wrapping
 * flex so the open confirm claims its own line beneath the figure it is about,
 * rather than pushing the token symbol out of its truncating column.
 *
 * Not `destructive`: attaching the holding again is an exact inverse and the
 * holding itself is never touched. What the sentence has to carry instead is
 * the *figure* — a share of a position is exactly what comes off the vault's
 * total, and "removed from the vault" describes nothing a reader can check.
 */

interface VaultHoldingRowProps {
  holding: VaultHoldingRowData;
  currencySymbol: string;
  onSavePercentage: (holdingId: string, percentage: number) => void;
  onDetach: (holdingId: string) => void;
  isSaving: boolean;
}

export function VaultHoldingRow({
  holding,
  currencySymbol,
  onSavePercentage,
  onDetach,
  isSaving,
}: VaultHoldingRowProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmingDetach, setConfirmingDetach] = useState(false);
  const editing = draft !== null;
  const valid = editing && isValidVaultPercentage(Number(draft));
  const symbol = holding.tokenSymbol || t('v3.vaults.holding.thisHolding');

  const save = () => {
    if (!valid) return;
    onSavePercentage(holding.holdingId, Number(draft));
    setDraft(null);
  };

  const where = [holding.institutionName, holding.accountName].filter(Boolean).join(' · ');

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">
          {holding.tokenSymbol || t('v3.vaults.holding.unknownToken')}
        </p>
        <p className="truncate text-caption text-muted-foreground">{where}</p>
      </div>

      {editing ? (
        <div className="flex shrink-0 items-center gap-1">
          <AmountInput
            value={draft ?? ''}
            onValueChange={setDraft}
            // 16px, because iOS zooms the page on focusing anything smaller and
            // the zoom reads as "the app jumped".
            className="h-9 w-20 text-body"
            decimalScale={1}
            suffix="%"
            aria-label={t('v3.vaults.holding.shareLabel', { symbol: holding.tokenSymbol })}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') setDraft(null);
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('v3.vaults.holding.cancel')}
            onClick={() => setDraft(null)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            aria-label={t('v3.vaults.holding.saveShare')}
            disabled={!valid || isSaving}
            onClick={save}
          >
            <Check className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col items-end">
            <Numeric
              value={attributedValue(holding)}
              currency={currencySymbol}
              className="text-label"
            />
            <button
              type="button"
              onClick={() => setDraft(String(holding.percentage))}
              aria-label={t('v3.vaults.holding.changeShare', {
                percent: holding.percentage,
                symbol: holding.tokenSymbol,
              })}
              className="inline-flex items-center gap-1 rounded-md px-1 text-caption text-muted-foreground transition-colors duration-fast ease-emphasized hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-mono tabular-nums tracking-numeric">
                {`${holding.percentage}%`}
              </span>
              <Pencil className="size-3" aria-hidden="true" />
            </button>
          </div>
          <ConfirmAction
            label={t('v3.vaults.holding.remove')}
            triggerClassName="shrink-0 text-muted-foreground"
            confirmLabel={t('v3.vaults.holding.removeCommit', { symbol })}
            open={confirmingDetach}
            onOpenChange={setConfirmingDetach}
            consequence={
              // One sentence, one key, the figure as a slot (SC-235). Split
              // into lead and tail around `<Numeric>` it read correctly only
              // in a language that puts the amount exactly there.
              <Trans
                i18nKey="v3.vaults.holding.detachConsequence"
                values={{ symbol, percent: holding.percentage }}
                components={{
                  value: (
                    <Numeric
                      value={attributedValue(holding)}
                      currency={currencySymbol}
                      className="text-caption"
                    />
                  ),
                }}
              />
            }
            onConfirm={() => {
              onDetach(holding.holdingId);
              setConfirmingDetach(false);
            }}
          />
        </>
      )}
    </li>
  );
}
