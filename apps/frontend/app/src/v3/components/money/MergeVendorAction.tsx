import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { type MergeCandidate, mergeConsequence } from '../../lib/money';
import { DuplicateVendorPicker } from './DuplicateVendorPicker';

/**
 * Fold a duplicate vendor into this one, from its peek sheet.
 *
 * The second destructive action V3-31 brought into v3, and the reason
 * `ConfirmAction` has a `chooser` slot: merge cannot state its consequence
 * until it knows which vendor is being folded in, so the choice is a step
 * inside the confirmation rather than a separate surface before it.
 *
 * DIRECTION IS FIXED, as it was in v2: the vendor whose sheet this is
 * always SURVIVES, and the picked one is always the one deleted. The
 * alternative — letting the reader merge the open record away — deletes
 * the thing they are looking at, and no amount of wording makes that
 * legible on a phone. The consequence sentence names both vendors and
 * which is which, so the direction is never inferred from button order.
 *
 * NEITHER a `Select` NOR `RecordPicker` (SC-78 §4). Both float their option
 * list, and on the installed PWA the `Select` this shipped with opened
 * *upward* over the sheet's own header and out onto the dimmed page — so the
 * reader could no longer see which vendor they were merging into while
 * choosing which one to delete — with rows at a 32pt pitch, under the 44pt
 * floor, because the token layer's coarse-pointer rule keys off `button` and a
 * Radix option is a `div`. `DuplicateVendorPicker` is laid out in the flow of
 * this block instead: nothing to escape a container, nothing to cover, and the
 * survivor named inside the list.
 */

interface MergeVendorActionProps {
  /** The vendor whose sheet this is. Always the survivor. */
  vendorId: string;
  vendorName: string;
  /** Every other vendor on the list — already loaded by the surface. */
  candidates: MergeCandidate[];
}

export function MergeVendorAction({ vendorId, vendorName, candidates }: MergeVendorActionProps) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState<string>('');

  const preview = trpc.vendors.mergePreview.useQuery(
    { intoId: vendorId, fromId },
    { enabled: open && fromId !== '' }
  );

  const mergeMutation = trpc.vendors.merge.useMutation({
    onSuccess: () => {
      setOpen(false);
      setFromId('');
      showSuccess('Vendors merged');
      // Payments move with the vendor, so the payment cache is stale too —
      // the merged-away name is still on those rows until it refetches.
      void utils.vendors.invalidate();
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, 'Merging vendors'),
  });

  const duplicate = candidates.find((candidate) => candidate.id === fromId);

  return (
    <ConfirmAction
      label="Merge duplicate"
      confirmLabel={duplicate ? `Merge ${duplicate.displayName} in` : 'Merge'}
      destructive
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Cancelling clears the choice: reopening should not sit on a
        // half-made decision the reader already backed out of.
        if (!next) setFromId('');
      }}
      disabledReason={candidates.length === 0 ? 'There is no other vendor to merge in' : undefined}
      // Picking the duplicate IS the deliberate second act; the commit is
      // the third. Until then there is nothing to agree to.
      canConfirm={Boolean(duplicate) && preview.data !== undefined}
      isPending={mergeMutation.isPending}
      chooser={
        <DuplicateVendorPicker
          survivorName={vendorName}
          candidates={candidates}
          value={fromId}
          onChange={setFromId}
          disabled={mergeMutation.isPending}
        />
      }
      consequence={
        duplicate
          ? mergeConsequence(vendorName, duplicate.displayName, preview.data ?? null)
          : `Pick a duplicate to fold into "${vendorName}". It keeps this record; the one you pick is deleted.`
      }
      onConfirm={() => {
        if (!duplicate) return;
        mergeMutation.mutate({ intoId: vendorId, fromId: duplicate.id });
      }}
    />
  );
}
