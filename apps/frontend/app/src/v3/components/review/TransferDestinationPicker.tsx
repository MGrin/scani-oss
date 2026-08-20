import type { TransferDestination } from '@scani/shared';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  destinationDetail,
  destinationLocation,
  destinationScale,
} from '../../lib/transfer-review';

/**
 * Where the money went, when it went somewhere Scani already tracks (SC-187).
 *
 * **The destination is a holding, not an account**, and that is the whole
 * reason this is a list rather than a select of account names. Production has
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * that tell them apart: the balance, and where the holding's numbers come
 * from.
 *
 * **Nothing is pre-selected, and nothing is ranked.** Guessing which account a
 * withdrawal went to is the same class of defect as auto-pairing a near-miss,
 * which SC-150 refused deliberately — and it would be a worse version of it,
 * because this answer *writes a transaction*. A wrong guess wearing a
 * checkmark the reader did not put there would put money in an account it
 * never reached.
 *
 * The last rows are accounts holding no position in this token. They are on
 * the list because "it went to an account I track that has never held USD" is
 * a real thing that happens, and sending the reader off to create a holding by
 * hand and come back would be the queue giving up on its own question. What it
 * does NOT do is hide the consequence: the row says a holding will be created,
 * and the confirm sentence says so again with the balance it will have.
 */

interface TransferDestinationPickerProps {
  destinations: TransferDestination[];
  tokenSymbol: string;
  /** The radio group's name — unique per transaction, since two pickers can
   *  exist at once (the whole answer's and the split editor's). */
  groupName: string;
  selected: TransferDestination | null;
  onSelect: (destination: TransferDestination) => void;
  isLoading: boolean;
}

export function TransferDestinationPicker({
  destinations,
  tokenSymbol,
  groupName,
  selected,
  onSelect,
  isLoading,
}: TransferDestinationPickerProps) {
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <p className="text-caption text-muted-foreground">
        {t('v3.review.destinationPicker.loading')}
      </p>
    );
  }
  if (destinations.length === 0) {
    return (
      <p className="text-body text-muted-foreground">
        {t('v3.review.destinationPicker.noDestinations')}
      </p>
    );
  }

  // One scale for the whole list — these balances are read as a column.
  const scale = destinationScale(destinations);

  return (
    <fieldset className="flex max-h-72 flex-col gap-2 overflow-y-auto">
      <legend className="sr-only">{t('v3.review.destinationPicker.legend')}</legend>
      {destinations.map((destination) => {
        const key = `${destination.accountId}:${destination.holdingId ?? 'new'}`;
        const isSelected =
          selected?.accountId === destination.accountId &&
          selected?.holdingId === destination.holdingId;
        return (
          <label
            key={key}
            // `min-h-11` is the 44px touch target; the whole row is the hit
            // area, which is the part that matters on a phone where a 20px dot
            // beside the text is a mis-tap that changes where money went.
            className={`flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-ring ${
              isSelected
                ? 'border-primary bg-primary/5'
                : 'border-border bg-surface-1 hover:bg-surface-hover'
            }`}
          >
            <input
              type="radio"
              name={groupName}
              checked={isSelected}
              onChange={() => onSelect(destination)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${
                isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
              }`}
            >
              {isSelected ? <Check className="size-3" /> : null}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-body font-medium">
                {destinationLocation(destination)}
              </span>
              <span className="text-caption text-muted-foreground">
                {destinationDetail(t, destination, tokenSymbol, scale)}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
