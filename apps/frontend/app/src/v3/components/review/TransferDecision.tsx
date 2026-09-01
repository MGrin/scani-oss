import type {
  PendingTransferReview,
  TransferCandidate,
  TransferDestination,
  TransferReviewDecision,
} from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { useToast } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Check, RotateCcw, StickyNote, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import {
  candidateLocation,
  candidateReasonLabel,
  candidateSummary,
  DECISION_LABELS,
  decisionConsequence,
  SPLIT_LABELS,
  SPLIT_NOTE_KEY,
  type SplitDraftRow,
  splitConsequence,
  splitIsCommittable,
  toSplitPortions,
  UNREVIEWED_TRANSFER_NOTE_KEY,
} from '../../lib/transfer-review';
import { TransferDestinationPicker } from './TransferDestinationPicker';
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
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openDecision, setOpenDecision] = useState<OpenAnswer>(null);
  const [destination, setDestination] = useState<TransferDestination | null>(null);
  const [splitRows, setSplitRows] = useState<SplitDraftRow[]>(() => emptySplitRows(null));

  // Fetched only once one of the two answers that can use it is open. The
  // queue's common path is one tap on a row that never opens either, and
  // paying for every row's account list on a queue of hundreds would be the
  // candidate search's cost charged a second time for nothing.
  const destinations = trpc.transferReview.listDestinations.useQuery(
    { transactionId: item.transactionId },
    { enabled: openDecision === 'internal' || openDecision === 'split' }
  );

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
            ? t('v3.review.decision.toast.paired')
            : variables.decision === 'internal'
              ? t('v3.review.decision.toast.internal')
              : variables.decision === 'left_control'
                ? t('v3.review.decision.toast.leftControl')
                : variables.decision === 'fee'
                  ? t('v3.review.decision.toast.fee')
                  : t('v3.review.decision.toast.untracked'),
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
        title: t('v3.review.decision.toast.gone'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
      setOpenDecision(null);
    },
  });

  const resolveSplit = trpc.transferReview.resolveSplit.useMutation({
    onSuccess: async () => {
      await invalidate();
      toast({ title: t('v3.review.decision.toast.split') });
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
        title: gone
          ? t('v3.review.decision.toast.gone')
          : t('v3.review.decision.toast.splitRejected'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
      if (gone) setOpenDecision(null);
    },
  });

  const chosen = item.candidates.find((c) => c.transactionId === selectedId) ?? null;
  const isPending = resolve.isPending || resolveSplit.isPending;
  // The candidate picker lives above both answers, so a candidate chosen
  // before the editor was opened has to reach the `paired` row inside it. The
  // destination is the split editor's own — it is picked per row, inside the
  // editor, because only the `internal` row has one.
  const rowsWithMatch = splitRows.map((row) =>
    row.decision === 'paired' ? { ...row, matchTransactionId: chosen?.transactionId ?? null } : row
  );

  const commit = (decision: TransferReviewDecision) => {
    resolve.mutate({
      transactionId: item.transactionId,
      decision,
      ...(decision === 'paired' && chosen ? { matchTransactionId: chosen.transactionId } : {}),
      ...(decision === 'internal' && destination
        ? {
            destination: {
              accountId: destination.accountId,
              holdingId: destination.holdingId,
            },
          }
        : {}),
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
      <WithdrawnAnswerNotice item={item} />
      <OwnWalletNotice item={item} />
      <RuleNotice item={item} />
      <section className="flex flex-col gap-2">
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
          {t('v3.review.decision.possibleMatches')}
        </h3>
        {item.candidates.length === 0 ? (
          <p className="text-body text-muted-foreground">
            {t('v3.review.decision.noCandidates', { symbol: item.tokenSymbol })}
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('v3.review.decision.candidatesLegend')}</legend>
            {item.candidates.map((candidate) => (
              <CandidateRow
                key={candidate.transactionId}
                candidate={candidate}
                groupName={`match-${item.transactionId}`}
                selected={candidate.transactionId === selectedId}
                onSelect={() => setSelectedId(candidate.transactionId)}
              />
            ))}
          </fieldset>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
          {t('v3.review.decision.whatHappened')}
        </h3>
        {openDecision === null ? (
          <p className="text-caption text-muted-foreground">{t(UNREVIEWED_TRANSFER_NOTE_KEY)}</p>
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
              label={t(DECISION_LABELS.paired.triggerKey)}
              confirmLabel={t(DECISION_LABELS.paired.commitKey)}
              consequence={decisionConsequence(t, 'paired', item, chosen)}
              // `canConfirm` false is "not yet — pick one", which is what the
              // consequence line says. `disabledReason` is for the case where
              // picking is not possible at all, and the two are not the same
              // state: a dead commit button behind an open confirm is the
              // thing `ConfirmAction`'s own doc calls out.
              canConfirm={Boolean(chosen)}
              {...(item.candidates.length === 0
                ? { disabledReason: t('v3.review.decision.noLinkTarget') }
                : {})}
              isPending={isPending}
              open={openDecision === 'paired'}
              onOpenChange={(open) => setOpenDecision(open ? 'paired' : null)}
              onConfirm={() => commit('paired')}
            />
          )}
          {/*
            The answer this queue was missing (SC-187).

            Second, directly under `Same money`, because it is the same claim —
            "it moved to a holding of mine" — reached the other way: there is
            no deposit to point at, so answering writes one. Putting it beside
            its twin is what makes the pair legible; putting it below the two
            answers that book or forfeit a gain would bury the correct answer
            under two wrong ones.
          */}
          {(openDecision === null || openDecision === 'internal') && (
            <ConfirmAction
              label={t(DECISION_LABELS.internal.triggerKey)}
              confirmLabel={t(DECISION_LABELS.internal.commitKey)}
              chooser={
                <TransferDestinationPicker
                  destinations={destinations.data ?? []}
                  tokenSymbol={item.tokenSymbol}
                  groupName={`destination-${item.transactionId}`}
                  selected={destination}
                  onSelect={setDestination}
                  isLoading={destinations.isLoading}
                />
              }
              consequence={decisionConsequence(t, 'internal', item, null, destination)}
              canConfirm={Boolean(destination)}
              isPending={isPending}
              open={openDecision === 'internal'}
              onOpenChange={(open) => setOpenDecision(open ? 'internal' : null)}
              onConfirm={() => commit('internal')}
            />
          )}
          {(openDecision === null || openDecision === 'left_control') && (
            <ConfirmAction
              label={t(DECISION_LABELS.left_control.triggerKey)}
              confirmLabel={t(DECISION_LABELS.left_control.commitKey)}
              consequence={decisionConsequence(t, 'left_control', item, null)}
              isPending={isPending}
              open={openDecision === 'left_control'}
              onOpenChange={(open) => setOpenDecision(open ? 'left_control' : null)}
              onConfirm={() => commit('left_control')}
            />
          )}
          {(openDecision === null || openDecision === 'untracked') && (
            <ConfirmAction
              label={t(DECISION_LABELS.untracked.triggerKey)}
              confirmLabel={t(DECISION_LABELS.untracked.commitKey)}
              consequence={decisionConsequence(t, 'untracked', item, null)}
              isPending={isPending}
              open={openDecision === 'untracked'}
              onOpenChange={(open) => setOpenDecision(open ? 'untracked' : null)}
              onConfirm={() => commit('untracked')}
            />
          )}
          {/*
            The whole row was a charge (SC-888) — a bank fee, a network fee, an
            exchange's withdrawal cut, imported with a kind the queue asks
            about. It sits below the other three because it is the rarest whole
            answer and the one this ticket was really about is the SPLIT below;
            a fee is usually PART of a transfer, not all of it.
          */}
          {(openDecision === null || openDecision === 'fee') && (
            <ConfirmAction
              label={t(DECISION_LABELS.fee.triggerKey)}
              confirmLabel={t(DECISION_LABELS.fee.commitKey)}
              consequence={decisionConsequence(t, 'fee', item, null)}
              isPending={isPending}
              open={openDecision === 'fee'}
              onOpenChange={(open) => setOpenDecision(open ? 'fee' : null)}
              onConfirm={() => commit('fee')}
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
              label={t(SPLIT_LABELS.triggerKey)}
              confirmLabel={t(SPLIT_LABELS.commitKey)}
              chooser={
                <TransferSplitEditor
                  item={item}
                  rows={rowsWithMatch}
                  onChange={setSplitRows}
                  hasMatch={Boolean(chosen)}
                  destinations={destinations.data ?? []}
                  destinationsLoading={destinations.isLoading}
                />
              }
              consequence={splitConsequence(t, rowsWithMatch, item, (id) =>
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
          <p className="text-caption text-muted-foreground">{t(SPLIT_NOTE_KEY)}</p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * "You wrote this down" — the note the reader left about this address
 * (SC-375).
 *
 * Above the answers for the same reason `OwnWalletNotice` is: the failure this
 * queue keeps producing is not a missing fact but a fact that arrives beside a
 * decision instead of in front of it. mgrin answered 560 transfers and his
 * summary of the experience was *"I honestly can not remember that anymore
 * anyway"* — so the note, in his own words, is the single most useful thing
 * that can be on this screen.
 *
 * It says a rule matched and it never says a rule answered — because a rule
 * that HAD answered this row would have taken it out of the queue. That was
 * trivially true in SC-375, where no verdict could write anything. It stays
 * true after SC-380 for a subtler reason worth stating: an `always_a_disposal`
 * rule can only reach this screen on a row whose answer the reader personally
 * took back, and that row is exempt from it permanently. So the second line
 * exists — the reader has to be told the standing sentence about this
 * destination is a disposal AND that this transfer is no longer covered by it,
 * or the note reads as a claim about the row in front of them.
 *
 * **Nothing below is pre-selected because of it**, whatever the verdict, which
 * is the same rule `OwnWalletNotice` follows for the strongest fact in the
 * dataset. A rule that pre-selected `left_control` here would be answering the
 * row it was just overruled on.
 */
function RuleNotice({ item }: { item: PendingTransferReview }) {
  const { t } = useTranslation();
  if (item.matchedRule === null) return null;
  return (
    <div className="flex gap-3 rounded-md border border-border bg-surface-1 p-3">
      <StickyNote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-caption text-muted-foreground">{t('v3.review.rules.notice.label')}</p>
        <p className="text-body">{item.matchedRule.note}</p>
        {item.matchedRule.verdict === 'always_a_disposal' ? (
          <p className="text-caption text-muted-foreground">
            {t('v3.review.rules.notice.markExempt')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "You answered this once, and Scani took the answer back" (SC-378).
 *
 * A question that reappears with no explanation reads as the queue losing an
 * answer, and the thing this whole surface depends on is a reader who trusts
 * it enough to keep answering. So the withdrawal says so, on the row, above
 * the candidates.
 *
 * It also does the work of the empty candidate list. These rows come back
 * with nothing to pair against, which without a sentence looks like a broken
 * search rather than the point: nothing arrived anywhere, so `left_control`
 * and `untracked` — both answerable with no candidate — are the answers.
 *
 * FIRST OF THE THREE NOTICES, AND THE ORDER IS THE MESSAGE.
 *
 * A row can carry all three at once — withdrawn, own-wallet, rule-matched, and
 * after SC-380 that combination is the ordinary shape of an overruled mark —
 * and they answer three different questions, in this sequence: *why am I
 * looking at this again* (withdrawn), then *what do I need in order to answer
 * it* (the address is yours; here is the note you left). Framing first, and
 * the two decision inputs nearest the buttons they inform. `OwnWalletNotice`
 * and `RuleNotice` keep the relative order SC-350 and SC-375 settled between
 * them; nothing here reopens that.
 *
 * The one arrangement that is actively WRONG is `RuleNotice` above this one.
 * Stacked that way it reads as the note having caused the question to come
 * back, and the causality runs the other way in both of the cases that reach
 * here: Scani withdrew a pairing it disproved, or the READER overruled the
 * rule's answer. A marking rule never un-answers anything — it only ever
 * writes, and only onto rows nobody has recorded a decision about (SC-380).
 * Conflating the two mechanisms on the one screen where both appear is the
 * misreading worth spending the position to prevent.
 *
 * **`user` became reachable in SC-380 and is not silent.** It used to mean the
 * reader reopening their own answer, which needs no explanation — but `reopen`
 * leaves the source null for that, and leaves `'user'` only when the answer it
 * withdrew came from a RULE. So this value now means one thing: you overruled
 * the standing sentence about this destination on this transfer. It is worth
 * saying because the consequence is invisible otherwise — the rule will never
 * answer this row again, and a reader who assumed it would is waiting for
 * something that is not coming.
 */
function WithdrawnAnswerNotice({ item }: { item: PendingTransferReview }) {
  const { t } = useTranslation();
  if (item.answerWithdrawnBy === null) return null;
  return (
    <div className="flex gap-3 rounded-md border border-border bg-surface-1 p-3">
      <RotateCcw className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-caption">
        {t(
          item.answerWithdrawnBy === 'repair'
            ? 'v3.review.decision.withdrawnNotice'
            : 'v3.review.decision.withdrawnRuleNotice'
        )}
      </p>
    </div>
  );
}

/**
 * "That address is one of yours" — the sentence the address was standing in for
 * (SC-350).
 *
 * On 2026-08-17 an owner answered a run of transfers `left_control` in a few
 * minutes, booking stablecoin disposals on money that had moved between two of
 * their own wallets. Every row already showed the destination: SC-346 had
 * shipped it forty-four minutes earlier, linked to Etherscan. It showed a raw
 * address they had registered themselves. A 42-character hex string is not a
 * thing a person recognises, and `left_control` is the one answer that books a
 * disposal.
 *
 * `user_wallets` held the answer the entire time and nothing joined it.
 *
 * ABOVE the candidates and the answers rather than beside the address in the
 * peek's field list, because the failure was not that the fact was unavailable
 * — it was on screen — but that it arrived as data at the moment a decision was
 * being made quickly. Ten answers in four minutes is roughly 25 seconds each;
 * this has to be in the path of the tap, not adjacent to it.
 *
 * It names the answer it is pointing at. "This is one of your wallets" still
 * leaves the reader to work out which of four buttons that implies, and the
 * whole lesson here is that a true fact placed near a decision is not the same
 * as a decision made easier.
 *
 * Nothing is disabled and nothing is pre-selected. A transfer to an address you
 * control CAN be a disposal — paying someone from a wallet you own is exactly
 * that — so the answer stays the reader's. SC-150's position is that the fix for
 * an ambiguous transfer is to ask, and this is a better-informed question, not a
 * narrower one.
 */
function OwnWalletNotice({ item }: { item: PendingTransferReview }) {
  const { t } = useTranslation();
  // Deliberately silent when false. `false` means "not among the wallets you
  // have registered", which is not the same as "this address is a stranger's" —
  // a cold wallet he never added reads identically — so the positive case may be
  // asserted and the negative one must not be.
  if (!item.counterpartyIsOwnWallet) return null;
  return (
    // `warning` is not a colour in the preset — `border-warning/40`,
    // `bg-warning/10` and `text-warning` each compiled to nothing, so the
    // callout rendered as bare text with no border, no fill and no icon
    // colour. The tokens that exist are the surface ramp and the border
    // hairline, which is what an informational callout is built from.
    <div className="flex gap-3 rounded-md border border-border bg-surface-hover p-3">
      <Wallet className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-caption">{t('v3.review.decision.ownWalletNotice')}</p>
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
  selected,
  onSelect,
}: {
  candidate: TransferCandidate;
  groupName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      // `min-h-11` is the 44px touch target.
      className={`flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-start transition-colors focus-within:ring-2 focus-within:ring-ring ${
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
        <span className="text-caption text-muted-foreground">{candidateSummary(t, candidate)}</span>
        <span
          className={`text-caption ${candidate.withinStrictTolerance ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {candidateReasonLabel(t, candidate)}
        </span>
      </span>
    </label>
  );
}
