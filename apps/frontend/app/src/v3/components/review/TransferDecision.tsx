import type {
  PendingTransferReview,
  TransferCandidate,
  TransferReviewDecision,
} from '@scani/shared';
import { useToast } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  candidateLocation,
  candidateReasonLabel,
  candidateSummary,
  DECISION_LABELS,
  decisionConsequence,
  SPLIT_LABELS,
  SPLIT_NOTE,
  type SplitDraftRow,
  splitConsequence,
  splitIsCommittable,
  toSplitPortions,
  UNREVIEWED_TRANSFER_NOTE,
} from '../../lib/transfer-review';
import { emptySplitRows, TransferSplitEditor } from './TransferSplitEditor';

/**
 * The answers, and the picker the first one needs (SC-150, SC-181).
 *
 * This is the part of the surface that does the work the ticket is about: it
 * turns "Scani could not tell whether this withdrawal was a sale" from a wrong
 * number nobody can see into a question with buttons under it.
 *
 * Three of those answers apply to the whole transaction and a fourth divides
 * it (SC-181) — a real 4,000 withdrawal was 3,500 moved somewhere untracked
 * and 500 that genuinely left, and with only whole answers the reader had to
 * pick which direction to be wrong in. The division sits last and behind its
 * own trigger, so the common case still costs one tap.
 *
 * **Nothing here is pre-selected, including the one obvious match.** That is
 * the rule the ticket states outright and it is easy to break for good-looking
 * reasons: when exactly one candidate is inside the matcher's own tolerance,
 * pre-checking it would save a tap and would produce a queue that empties
 * itself by guessing, with the guess wearing a checkmark the reader put there.
 * The candidate that would have matched is *labelled* as such and sorted
 * first — which is help — and it still takes a deliberate tap.
 *
 * The picker lives in the sheet body rather than inside `ConfirmAction`'s
 * `chooser` slot, which is where `MergeVendorAction` puts its equivalent. The
 * difference is size: a vendor merge chooses one row from a `Command` palette,
 * while this is up to eight rows each carrying three lines of comparison, and
 * `ConfirmAction` renders in the peek's fixed header. Choosing first and
 * confirming second also matches the actual order of the judgement — you work
 * out which deposit it was, then you say so.
 */

interface TransferDecisionProps {
  item: PendingTransferReview;
  /** Called after a successful write, so the sheet can close back to the
   *  queue the reader is working through. */
  onResolved: () => void;
}

/** `null` = nothing open; a decision, or the split editor. */
type OpenAnswer = TransferReviewDecision | 'split' | null;

export function TransferDecision({ item, onResolved }: TransferDecisionProps) {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openDecision, setOpenDecision] = useState<OpenAnswer>(null);
  const [splitRows, setSplitRows] = useState<SplitDraftRow[]>(() => emptySplitRows(null));

  const invalidate = async () => {
    // Three reads of one fact since SC-181: the queue's list, the review
    // feed's count, and the answered list a reopened row comes back from. A
    // badge that still says 4 over an empty page is the disagreement
    // `useReviewFeed` exists to prevent, and the same argument covers the
    // third one.
    await Promise.all([
      utils.transferReview.listPending.invalidate(),
      utils.transferReview.listAnswered.invalidate(),
      utils.review.listPending.invalidate(),
    ]);
  };

  const resolve = trpc.transferReview.resolve.useMutation({
    onSuccess: async (_data, variables) => {
      await invalidate();
      toast({
        title:
          variables.decision === 'paired'
            ? 'Linked — the cost basis moves with it'
            : variables.decision === 'left_control'
              ? 'Recorded as a disposal'
              : 'Recorded as still yours',
      });
      setOpenDecision(null);
      onResolved();
    },
    onError: async (error) => {
      // NOT_FOUND here means somebody answered it elsewhere, or the nightly
      // matcher paired it while the sheet was open. Refetching is the honest
      // response: the row goes away and the reader sees why.
      await utils.transferReview.listPending.invalidate();
      toast({
        title: 'That transfer is no longer waiting',
        description: error.message,
        variant: 'destructive',
      });
      setOpenDecision(null);
    },
  });

  const resolveSplit = trpc.transferReview.resolveSplit.useMutation({
    onSuccess: async () => {
      await invalidate();
      toast({ title: 'Recorded — each part on its own terms' });
      setOpenDecision(null);
      onResolved();
    },
    onError: async (error) => {
      // A BAD_REQUEST here is the sum rule failing on the server, which the
      // editor should already have caught — so the message carries the
      // expected total rather than a generic refusal, and the sheet stays
      // open with the reader's numbers in it. Only a NOT_FOUND takes the
      // question away, and only then is a refetch the honest response.
      const gone = error.data?.code === 'NOT_FOUND';
      if (gone) await utils.transferReview.listPending.invalidate();
      toast({
        title: gone ? 'That transfer is no longer waiting' : 'That division was not accepted',
        description: error.message,
        variant: 'destructive',
      });
      if (gone) setOpenDecision(null);
    },
  });

  const chosen = item.candidates.find((c) => c.transactionId === selectedId) ?? null;
  const isPending = resolve.isPending || resolveSplit.isPending;
  // The picker lives above both answers, so a candidate chosen before the
  // editor was opened has to reach the `paired` row inside it.
  const rowsWithMatch = splitRows.map((row) =>
    row.decision === 'paired' ? { ...row, matchTransactionId: chosen?.transactionId ?? null } : row
  );

  const commit = (decision: TransferReviewDecision) => {
    resolve.mutate({
      transactionId: item.transactionId,
      decision,
      ...(decision === 'paired' && chosen ? { matchTransactionId: chosen.transactionId } : {}),
    });
  };

  const commitSplit = () => {
    resolveSplit.mutate({
      transactionId: item.transactionId,
      split: toSplitPortions(rowsWithMatch),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
          Possible matches
        </h3>
        {item.candidates.length === 0 ? (
          <p className="text-body text-muted-foreground">
            No deposit of {item.tokenSymbol} landed anywhere in Scani within a week of this, at a
            comparable amount. If it went somewhere Scani cannot see, say so below.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Possible matching deposits</legend>
            {item.candidates.map((candidate) => (
              <CandidateRow
                key={candidate.transactionId}
                candidate={candidate}
                groupName={`match-${item.transactionId}`}
                tokenSymbol={item.tokenSymbol}
                selected={candidate.transactionId === selectedId}
                onSelect={() => setSelectedId(candidate.transactionId)}
              />
            ))}
          </fieldset>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
          What happened
        </h3>
        {openDecision === null ? (
          <p className="text-caption text-muted-foreground">{UNREVIEWED_TRANSFER_NOTE}</p>
        ) : null}
        {/*
          While one answer is open, the other two are NOT rendered.

          The phone capture is the argument: the confirm's Cancel sits up and
          to the left, and the two untouched triggers sit directly under the
          thumb below it. A misaimed tap there does not cancel — it commits a
          *different* decision on the same transfer, and the reader has no
          reason to look for a second question they never opened.
          `ConfirmAction` already puts distance between a trigger and its own
          commit; this is the same rule applied between siblings.
        */}
        <div className="flex flex-col gap-2">
          {(openDecision === null || openDecision === 'paired') && (
            <ConfirmAction
              label={DECISION_LABELS.paired.trigger}
              confirmLabel={DECISION_LABELS.paired.commit}
              consequence={decisionConsequence('paired', item, chosen)}
              // `canConfirm` false is "not yet — pick one", which is what the
              // consequence line says. `disabledReason` is for the case where
              // picking is not possible at all, and the two are not the same
              // state: a dead commit button behind an open confirm is the
              // thing `ConfirmAction`'s own doc calls out.
              canConfirm={Boolean(chosen)}
              {...(item.candidates.length === 0
                ? { disabledReason: 'No deposit close enough to link this to' }
                : {})}
              isPending={isPending}
              open={openDecision === 'paired'}
              onOpenChange={(open) => setOpenDecision(open ? 'paired' : null)}
              onConfirm={() => commit('paired')}
            />
          )}
          {(openDecision === null || openDecision === 'left_control') && (
            <ConfirmAction
              label={DECISION_LABELS.left_control.trigger}
              confirmLabel={DECISION_LABELS.left_control.commit}
              consequence={decisionConsequence('left_control', item, null)}
              isPending={isPending}
              open={openDecision === 'left_control'}
              onOpenChange={(open) => setOpenDecision(open ? 'left_control' : null)}
              onConfirm={() => commit('left_control')}
            />
          )}
          {(openDecision === null || openDecision === 'untracked') && (
            <ConfirmAction
              label={DECISION_LABELS.untracked.trigger}
              confirmLabel={DECISION_LABELS.untracked.commit}
              consequence={decisionConsequence('untracked', item, null)}
              isPending={isPending}
              open={openDecision === 'untracked'}
              onOpenChange={(open) => setOpenDecision(open ? 'untracked' : null)}
              onConfirm={() => commit('untracked')}
            />
          )}
          {/*
            The fourth answer, last (SC-181).

            Last because it is the least common and the most work: three of
            four transfers are one thing, and putting the amount fields above
            the one-tap answers would charge every reader for the case that
            needs them. It is a peer of the other three rather than a mode
            switch on them — the same trigger-then-confirm shape, the same
            consequence sentence, and the same rule that an open answer hides
            its siblings so a misaimed tap cannot commit a different one.
          */}
          {(openDecision === null || openDecision === 'split') && (
            <ConfirmAction
              label={SPLIT_LABELS.trigger}
              confirmLabel={SPLIT_LABELS.commit}
              chooser={
                <TransferSplitEditor
                  item={item}
                  rows={rowsWithMatch}
                  onChange={setSplitRows}
                  hasMatch={Boolean(chosen)}
                />
              }
              consequence={splitConsequence(rowsWithMatch, item, (id) =>
                id ? (item.candidates.find((c) => c.transactionId === id) ?? null) : null
              )}
              canConfirm={splitIsCommittable(rowsWithMatch, item)}
              isPending={isPending}
              open={openDecision === 'split'}
              onOpenChange={(open) => setOpenDecision(open ? 'split' : null)}
              onConfirm={commitSplit}
            />
          )}
        </div>
        {openDecision === null ? (
          <p className="text-caption text-muted-foreground">{SPLIT_NOTE}</p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * One candidate, as a radio.
 *
 * Three lines rather than one: where it landed, what and when, and why the
 * matcher would not take it. On a 390px screen that is the whole comparison
 * without a horizontal scroll, and the third line is the one that makes the
 * choice possible — "Matches — but so does another deposit" tells the reader
 * they are the tie-break, which is a different job from "0.4% off" and needs
 * different care.
 *
 * A real `<input type="radio">` inside a `<label>`, not a button with
 * `role="radio"`. The native control brings arrow-key movement within the
 * group and the right VoiceOver announcement for free, and the label makes the
 * whole three-line row the hit area — which is the part that matters on a
 * phone, where a 20px dot beside the text is a mis-tap that silently changes
 * which transfer is about to be linked.
 */
function CandidateRow({
  candidate,
  groupName,
  tokenSymbol,
  selected,
  onSelect,
}: {
  candidate: TransferCandidate;
  groupName: string;
  tokenSymbol: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      // `min-h-11` is the 44px touch target.
      className={`flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-ring ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-surface-1 hover:bg-surface-hover'
      }`}
    >
      <input
        type="radio"
        name={groupName}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
        }`}
      >
        {selected ? <Check className="size-3" /> : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-body font-medium">{candidateLocation(candidate)}</span>
        <span className="text-caption text-muted-foreground">
          {candidateSummary(candidate, tokenSymbol)}
        </span>
        <span
          className={`text-caption ${candidate.withinStrictTolerance ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {candidateReasonLabel(candidate)}
        </span>
      </span>
    </label>
  );
}
