import type { BulkTransferApplied, BulkTransferDecision } from '@scani/shared';
import { MAX_BULK_TRANSFER_ROWS, undoEntriesFor } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { ToastAction } from '@scani/ui/ui/toast';
import { useToast } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { BULK_LABELS, bulkConsequence, bulkRefusalNotes } from '../../lib/transfer-review';

/**
 * One answer, applied to every selected transfer (SC-382).
 *
 * mgrin asked for this directly — *"I want to select multiple transfers and
 * apply the same decision to them"* — and the selection is the easy half. Two
 * answers are offered and not four, because `paired` names one deposit,
 * `internal` names one destination holding, and `split` is amounts that must
 * sum to one row's quantity: none of the three is a claim that can be true of
 * twelve rows at once. See `BULK_TRANSFER_DECISIONS`.
 *
 * **`left_control` is the only answer that books a disposal**, so applying it
 * to twelve rows books twelve capital gains on one tap — the most consequential
 * control in the product. Three things stand between the tap and the write, and
 * all three are here rather than in a comment:
 *
 * - **The confirmation says what it will do in money.** Not "12 transfers" — a
 *   count asks the reader to trust it, and the number they can check is the one
 *   the ledger moves by. It comes from `bulkPreview`, computed over the same
 *   rows the write will take, because the answered list carries no price of its
 *   own and a client-side sum would be silent exactly where it matters.
 * - **The rows it cannot write are named, and the commit waits.** Nothing is
 *   silently dropped and nothing is silently narrowed: the reader deselects,
 *   which keeps the selection theirs.
 * - **`ConfirmAction`, like every other write on this surface.** Cancel takes
 *   the trigger's position, and the commit is labelled with the count rather
 *   than with the trigger's noun.
 *
 * The undo is the toast. `bulkResolve` returns the answer it replaced on every
 * row, and `undoEntriesFor` hands that straight back — exact, because every
 * state this can write is link-free, so there is no deposit to re-create and no
 * group id to restore. After a refresh the durable fallback is the answered
 * list's per-row Reopen, which every row this writes is eligible for.
 */

interface TransferBulkActionProps {
  selectedIds: Set<string>;
  clearSelection: () => void;
  /** Drop the rows the write refused, so the reader can commit the rest
   *  without rebuilding the selection by hand. */
  deselect: (ids: readonly string[]) => void;
  /** Every read of the queue that this write invalidates. */
  onWritten: () => Promise<void>;
}

export function TransferBulkAction({
  selectedIds,
  clearSelection,
  deselect,
  onWritten,
}: TransferBulkActionProps) {
  const [open, setOpen] = useState<BulkTransferDecision | null>(null);
  return (
    <>
      {/*
        While one answer is open the other is NOT rendered — the same rule
        `TransferDecision` follows between siblings, and it matters more here.
        A misaimed tap next to an open confirm would not cancel; it would open
        the *disposal* over a selection the reader had lined up for the answer
        that books nothing.
      */}
      {(open === null || open === 'left_control') && (
        <BulkDecisionAction
          decision="left_control"
          destructive
          selectedIds={selectedIds}
          clearSelection={clearSelection}
          deselect={deselect}
          onWritten={onWritten}
          open={open === 'left_control'}
          onOpenChange={(next) => setOpen(next ? 'left_control' : null)}
        />
      )}
      {(open === null || open === 'untracked') && (
        <BulkDecisionAction
          decision="untracked"
          selectedIds={selectedIds}
          clearSelection={clearSelection}
          deselect={deselect}
          onWritten={onWritten}
          open={open === 'untracked'}
          onOpenChange={(next) => setOpen(next ? 'untracked' : null)}
        />
      )}
    </>
  );
}

function BulkDecisionAction({
  decision,
  destructive,
  selectedIds,
  clearSelection,
  deselect,
  onWritten,
  open,
  onOpenChange,
}: TransferBulkActionProps & {
  decision: BulkTransferDecision;
  destructive?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const ids = [...selectedIds];
  const overCap = ids.length > MAX_BULK_TRANSFER_ROWS;

  // Only once the reader has opened this answer. The bar is on screen for
  // every selection, and pricing a selection nobody is about to commit would
  // charge the queue's own per-row price lookup a second time for nothing.
  const preview = trpc.transferReview.bulkPreview.useQuery(
    { transactionIds: ids, decision },
    { enabled: open && ids.length > 0 && !overCap }
  );

  const apply = trpc.transferReview.bulkResolve.useMutation({
    onSuccess: async ({ applied }) => {
      await onWritten();
      onOpenChange(false);
      clearSelection();
      toast({
        title: t(
          `v3.review.transfer.bulk.toast.${decision === 'left_control' ? 'leftControl' : 'untracked'}`,
          {
            count: applied.length,
          }
        ),
        action: <UndoAction applied={applied} onWritten={onWritten} />,
      });
    },
    onError: async (error) => {
      // A CONFLICT here is a race the preview could not have seen — the
      // nightly matcher claiming a row, or a second tab answering it. Nothing
      // was written, so the honest response is to re-read and re-price: the
      // confirmation repaints with the new refusal itemised against the row.
      await Promise.all([onWritten(), preview.refetch()]);
      toast({
        title: t('v3.review.transfer.bulk.toast.refused'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
    },
  });

  const refusals = preview.data?.refusals ?? [];
  const eligible = preview.data?.eligible ?? [];

  return (
    <ConfirmAction
      label={t(BULK_LABELS[decision].triggerKey)}
      confirmLabel={t(BULK_LABELS[decision].commitKey, { count: eligible.length })}
      destructive={destructive}
      {...(overCap
        ? {
            disabledReason: t('v3.review.transfer.bulk.overCap', {
              max: MAX_BULK_TRANSFER_ROWS,
            }),
          }
        : {})}
      chooser={
        refusals.length > 0 ? (
          // `warning` is not a colour in the preset, so `border-warning/40`
          // and `bg-warning/10` compiled to nothing and this callout drew
          // neither a border nor a fill.
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-hover p-3">
            {bulkRefusalNotes(t, refusals).map((note) => (
              <p key={note} className="text-caption">
                {note}
              </p>
            ))}
            <button
              type="button"
              className="self-start text-caption underline underline-offset-2"
              onClick={() => deselect(refusals.map((r) => r.transactionId))}
            >
              {t('v3.review.transfer.bulk.deselect', { count: refusals.length })}
            </button>
          </div>
        ) : undefined
      }
      consequence={bulkConsequence(t, decision, preview.data)}
      // Three distinct "not yet"s, and only this one is recoverable by waiting
      // or by tapping: the price is still landing, or there are rows the write
      // will not take and they are listed directly above with the control that
      // clears them.
      canConfirm={!preview.isLoading && refusals.length === 0 && eligible.length > 0}
      isPending={apply.isPending}
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={() =>
        apply.mutate({
          // The preview's own list, not the selection — so the ids the reader
          // saw priced are exactly the ids that get written.
          entries: eligible.map((transactionId) => ({ transactionId, decision })),
        })
      }
    />
  );
}

/**
 * "Undo" on the toast, and the whole of the immediate reversal.
 *
 * It replays the answers the batch replaced rather than reopening the rows:
 * putting them back in the queue would be right only for the rows that were
 * never answered, and wrong for every row that already carried one. That
 * distinction is what `applied` carries and what `undoEntriesFor` preserves.
 */
function UndoAction({
  applied,
  onWritten,
}: {
  applied: BulkTransferApplied[];
  onWritten: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const undo = trpc.transferReview.bulkResolve.useMutation({
    onSuccess: async () => {
      await onWritten();
      toast({ title: t('v3.review.transfer.bulk.toast.undone', { count: applied.length }) });
    },
    onError: async (error) => {
      await onWritten();
      toast({
        title: t('v3.review.transfer.bulk.toast.undoFailed'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
    },
  });
  return (
    <ToastAction
      altText={t('v3.review.transfer.bulk.undo')}
      onClick={() => undo.mutate({ entries: undoEntriesFor(applied) })}
      disabled={undo.isPending}
    >
      {t('v3.review.transfer.bulk.undo')}
    </ToastAction>
  );
}
