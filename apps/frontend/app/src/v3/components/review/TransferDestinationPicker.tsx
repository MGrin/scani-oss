import type { TransferDestination } from '@scani/shared';
import { AccountPicker, type AccountPickerOption } from '@scani/ui/v3/components/AccountPicker';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { destinationDetail, destinationGroup, destinationScale } from '../../lib/transfer-review';

/**
 * Where the money went, when it went somewhere Scani already tracks (SC-187).
 *
 * **The destination is a holding, not an account**, and that is the whole
 * reason this is a list rather than a select of account names. Production has
 * one Airwallex account carrying two USD holdings — 1,201.50 imported and
 * 6,217.15 manual — with a withdrawal that moved between them. By account and
 * symbol they are the same row twice, so each one has to carry the two facts
 * that tell them apart: the balance, and where the holding's numbers come
 * from.
 *
 * **Nothing is pre-selected.** Guessing which account a withdrawal went to is
 * the same class of defect as auto-pairing a near-miss, which SC-150 refused
 * deliberately — and it would be a worse version of it, because this answer
 * *writes a transaction*. A wrong guess wearing a checkmark the reader did not
 * put there would put money in an account it never reached.
 *
 * **It IS ranked, and that is a different act** (SC-850). The list arrives in
 * three bands — accounts already holding this token, accounts on the chain the
 * money is leaving, then the rest — because the flat alphabetical list was
 * itself a ranking, by a fact about the account's name, and it offered an
 * Airwallex fiat account above every Solana wallet for a SOL transfer. An
 * order can be ignored by scrolling; a pre-selection cannot.
 *
 * The last band is accounts holding no position in this token. They are on the
 * list because "it went to an account I track that has never held SOL" is a
 * real thing that happens, and sending the reader off to create a holding by
 * hand and come back would be the queue giving up on its own question. What it
 * does NOT do is hide the consequence: the band's heading says a holding will
 * be created, and the confirm sentence says so again with the balance it will
 * have.
 *
 * **The control itself is `@scani/ui`'s `AccountPicker`, not this file's own.**
 * Fourteen surfaces in this app ask which account and every one of them had
 * grown its own spelling; this was the worst of them and is the first to
 * adopt the shared one.
 */

/** A destination's identity for the radio group — `accountId` is not unique. */
function destinationId(destination: TransferDestination): string {
  return `${destination.accountId}:${destination.holdingId ?? 'new'}`;
}

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

  const options = useMemo<AccountPickerOption[]>(() => {
    // One scale for the whole list — these balances are read as a column.
    const scale = destinationScale(destinations);
    return destinations.map((destination) => ({
      id: destinationId(destination),
      name: destination.accountName,
      institution: destination.institutionName,
      subtitle: destinationDetail(destination, tokenSymbol, scale) ?? undefined,
      ...destinationGroup(t, destination, tokenSymbol),
    }));
  }, [destinations, tokenSymbol, t]);

  const byId = useMemo(
    () => new Map(destinations.map((destination) => [destinationId(destination), destination])),
    [destinations]
  );

  return (
    <AccountPicker
      options={options}
      value={selected ? destinationId(selected) : null}
      onChange={(option) => {
        const destination = byId.get(option.id);
        if (destination) onSelect(destination);
      }}
      name={groupName}
      legend={t('v3.review.destinationPicker.legend')}
      searchPlaceholder={t('v3.review.destinationPicker.searchPlaceholder')}
      emptyLabel={t('v3.review.destinationPicker.noDestinations')}
      isLoading={isLoading}
      loadingLabel={t('v3.review.destinationPicker.loading')}
    />
  );
}
