import type { AnsweredTransferReview, AnswerSource } from '@scani/shared';
import { formatDate } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { useToast } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportDateTime, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import type { TFunction } from 'i18next';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { formatRelative } from '../../lib/relative-time';
import { TRANSFER_ANSWERED_PATH, TRANSFER_REVIEW_PATH } from '../../lib/routes';
import { answeredSummary, pendingLocation, reopenConsequence } from '../../lib/transfer-review';
import { TransferBulkAction } from './TransferBulkAction';

/**
 * Transfers already answered, and the one action on them (SC-181).
 *
 * Its reason to exist is a number: 573 transfers were answered `left_control`
 * in a single bulk pass, before an answer could apply to part of a transaction.
 * Any of them that were partly a move between the reader's own accounts now
 * overstate the realized gain, and the withdrawal that prompted SC-181 is one
 * of them — so shipping the division with no route to an answered row would
 * leave the reported case unfixable.
 *
 * **The only action is Reopen.** Re-answering in place would need the
 * candidate search and the price lookup the pending list pays for per row,
 * against a list that is two orders of magnitude longer; reopening costs one
 * mutation and hands the row back to the queue, where the full surface already
 * lives. It is also the honest sequence — an answer is withdrawn, then a new
 * one is given, and the row's state is never two answers at once.
 *
 * Reopening is confirmed rather than immediate because it moves a number: an
 * outflow answered `left_control` carries a realized gain, and putting it back
 * in the queue takes that gain off the chart until the reader answers again.
 *
 * **The "Answered" column is the point of SC-241, not decoration.** 573 of
 * these 579 rows carry an answer nobody gave in this queue, and until now the
 * list rendered them under the header "Your answer" — telling the reader they
 * had decided something they were never asked. The column names what our
 * records actually say for each row: a date when the reader answered it here,
 * and "Not recorded" when there is no such record. The filter is what turns
 * that into an action, because the six rows a person did answer are otherwise
 * six in five hundred.
 */

interface AnsweredTransferListProps {
  items: AnsweredTransferReview[];
  query: V3QueryState;
  /**
   * Required, not optional (SC-244). `items` is one page of up to 579 answered
   * rows, and a search over the page reported "No transfers match “Revolut”" —
   * the sentence this surface uses for a reader who has answered nothing.
   */
  onSearch: (term: string) => void;
}

export function AnsweredTransferList({ items, query, onSearch }: AnsweredTransferListProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  const invalidate = async () => {
    await Promise.all([
      utils.transferReview.listAnswered.invalidate(),
      utils.transferReview.listPending.invalidate(),
      utils.review.listPending.invalidate(),
    ]);
  };
  const config: V3DataViewConfig<AnsweredTransferReview> = {
    pageKey: 'transfer-answered',
    data: items,
    nounKey: 'ui.dataView.noun.transfers',
    searchPlaceholderKey: 'ui.dataView.answeredTransfers.config.searchAnsweredTransfers',
    // Server-side (SC-244): the same four fields, concatenated the same way, so
    // "kraken btc" still matches one row across two columns.
    onSearch,
    filterDefs: [
      {
        // The only way six rows in five hundred are findable. Still client-side
        // — the ordering puts every `user` row on the first page, which is the
        // case it is for — and `V3DataView` now says "of 100 loaded so far"
        // rather than presenting the page as the whole set.
        key: 'answerSource',
        labelKey: 'ui.dataView.answeredTransfers.filter.answered',
        options: answerSourceOptions(t),
        fn: (item: AnsweredTransferReview, value: string) => item.answerSource === value,
      },
    ],
    sortDefs: [
      { key: 'answered', labelKey: 'ui.dataView.answeredTransfers.sort.answered' },
      { key: 'occurred', labelKey: 'ui.dataView.answeredTransfers.sort.when' },
      { key: 'token', labelKey: 'ui.dataView.answeredTransfers.sort.asset' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      if (field === 'token') return a.tokenSymbol.localeCompare(b.tokenSymbol) * mult;
      if (field === 'answered') {
        // Undated rows go last in BOTH directions rather than sorting as epoch
        // zero — an ordering that puts them first is the whole of SC-241 — and
        // they fall back to `occurredAt`, newest first, so the block below is
        // not arbitrary. No `mult` on that fallback: the block is pinned either
        // way, so reversing inside it only ever reads as a glitch.
        if (!a.reviewedAt || !b.reviewedAt) {
          if (a.reviewedAt) return -1;
          if (b.reviewedAt) return 1;
          return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
        }
        return (new Date(a.reviewedAt).getTime() - new Date(b.reviewedAt).getTime()) * mult;
      }
      return (new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()) * mult;
    },
    // Matches what the server orders and pages by. A client default that sorts
    // on a different key than the cursor does is how a paginated list starts
    // lying: "Load more" then inserts the next page into the middle, and the
    // rows the reader came for sit at the bottom of page one. Measured — before
    ***REMOVED***
    defaultSort: { field: 'answered', direction: 'desc' },
    renderRow: (item) => ({
      label: `${item.quantity} ${item.tokenSymbol}`,
      // The marker belongs here and not only in the desktop column: the phone
      // list renders `renderRow` and nothing else, and on an installed PWA that
      // is the surface. A distinction that exists only in the table is a
      // distinction most readers never see.
      sublabel: [pendingLocation(item), answeredSummary(t, item), unrecordedNote(t, item)]
        .filter(Boolean)
        .join(' · '),
      // No figure: this list carries no price lookup, and a blank value zone
      // is the honest rendering of "we did not ask" — see `listAnswered`.
      value: null,
      delta: (
        <span className="text-muted-foreground">
          {formatRelative(t, new Date(item.occurredAt))}
        </span>
      ),
      ariaLabel: rowName([
        `${item.quantity} ${item.tokenSymbol}`,
        pendingLocation(item),
        answeredSummary(t, item),
        unrecordedNote(t, item),
      ]),
    }),
    columns: [
      {
        key: 'asset',
        headerKey: 'ui.dataView.answeredTransfers.col.left',
        sortable: true,
        render: (item) => `${item.quantity} ${item.tokenSymbol}`,
      },
      {
        key: 'from',
        headerKey: 'ui.dataView.answeredTransfers.col.from',
        render: (item) => pendingLocation(item),
      },
      {
        // "Answer", not "Your answer": the header has to be true of every row,
        // and it is not true of the 573 (SC-241). Who answered is its own
        // column now rather than an adjective on this one.
        key: 'answer',
        headerKey: 'ui.dataView.answeredTransfers.col.answer',
        render: (item) => <span className="truncate">{answeredSummary(t, item)}</span>,
        exportValue: (item) => exportText(answeredSummary(t, item)),
      },
      {
        key: 'answered',
        headerKey: 'ui.dataView.answeredTransfers.col.answered',
        sortable: true,
        width: 'w-40',
        render: (item) =>
          item.reviewedAt ? (
            formatDate(item.reviewedAt)
          ) : (
            <span className="text-muted-foreground">{t(ANSWER_SOURCE_UNRECORDED_KEY)}</span>
          ),
        exportValue: (item) =>
          item.reviewedAt
            ? exportDateTime(new Date(item.reviewedAt))
            : exportText(t(ANSWER_SOURCE_UNRECORDED_KEY)),
      },
      {
        key: 'occurred',
        headerKey: 'ui.dataView.answeredTransfers.col.when',
        sortable: true,
        width: 'w-40',
        render: (item) => (
          <span className="text-muted-foreground">
            {formatRelative(t, new Date(item.occurredAt))}
          </span>
        ),
        exportValue: (item) => exportDateTime(new Date(item.occurredAt)),
      },
    ],
    empty: {
      icon: Inbox,
      titleKey: 'ui.dataView.answeredTransfers.empty.noTransfersAnsweredYet',
      descriptionKey: 'ui.dataView.answeredTransfers.empty.answersYouGiveInTheTransfer',
      action: (
        <Button asChild variant="outline">
          <Link to={TRANSFER_REVIEW_PATH}>{t('v3.review.answered.backToQueue')}</Link>
        </Button>
      ),
    },
    /*
      RE-answer in bulk, which is the operation SC-186 asked for and SC-382
      absorbed. Production holds 219 `left_control` answers — 190 of them from
      the raw UPDATE of 2026-08-14 — clustered on a handful of destinations,
      23 to one address and 20 to another. Answering a block of those
      `untracked` is one tap that takes a wrong realized gain back off.

      Reopening in bulk is deliberately NOT offered beside it: none of those
      rows has a plausible inbound to pair with even under a ±10% / ±7-day net,
      so a "put these back in the queue" button returns them with no candidates
      and the same question. Un-answering exists only as the undo of a tap just
      taken, on the toast.

      The bar refuses a `paired`, `internal` or `split` row rather than
      rewriting it: those carry a group id and possibly a deposit this feature
      wrote, and taking one back is `Reopen`'s job, per row.
    */
    renderBulkActions: (selectedIds, clearSelection, deselect) => (
      <TransferBulkAction
        selectedIds={selectedIds}
        clearSelection={clearSelection}
        deselect={deselect}
        onWritten={invalidate}
      />
    ),
    peek: {
      basePath: TRANSFER_ANSWERED_PATH,
      render: (item) => ({
        title: `${item.quantity} ${item.tokenSymbol}`,
        subtitle: `${t(item.kind === 'withdraw' ? 'v3.review.kind.withdrawal' : 'v3.review.kind.transferOut')} · ${pendingLocation(item)}`,
        delta: (
          <span className="text-muted-foreground">
            {formatRelative(t, new Date(item.occurredAt))}
          </span>
        ),
        primary: [
          {
            label: t(ANSWER_SOURCE_ATTRIBUTION_KEYS[item.answerSource]),
            value: answeredSummary(t, item),
          },
          // Unconditional. Dropping the row when there is no date is what made
          // an answer nobody gave read exactly like one the reader gave.
          {
            label: t('v3.review.answered.field.answered'),
            value: item.reviewedAt
              ? formatDate(item.reviewedAt)
              : t(ANSWER_SOURCE_UNRECORDED_LONG_KEY),
          },
          ...(item.counterparty
            ? [{ label: t('v3.review.answered.field.to'), value: item.counterparty }]
            : []),
        ],
        content: <ReopenAction item={item} />,
      }),
    },
  };

  return <V3DataView config={config} getId={(item) => item.transactionId} query={query} />;
}

/**
 * What we can say about a row with no `transfer_reviewed_at`, and no more.
 *
 * Not "answered automatically" and not "answered by an import": the stamp is
 * written in exactly two places, both in the review queue, and the column
 * landed in the same commit as the queue — so its absence proves the answer did
 * not come through here, and proves nothing at all about who did give it.
 */
const ANSWER_SOURCE_UNRECORDED_KEY = 'v3.review.answered.source.unrecorded';
const ANSWER_SOURCE_UNRECORDED_LONG_KEY = 'v3.review.answered.source.unrecordedLong';

/** Keyed by the union rather than listed, so a third source cannot ship
 *  unlabelled — which is how the second one shipped indistinguishable.
 *
 *  It earned its keep: `repair` arrived in SC-350 and this line failed the
 *  type-check rather than rendering a blank chip. */
const ANSWER_SOURCE_LABEL_KEYS: Record<AnswerSource, string> = {
  user: 'v3.review.answered.source.user',
  rule: 'v3.review.answered.source.rule',
  repair: 'v3.review.answered.source.repair',
  unattributed: ANSWER_SOURCE_UNRECORDED_KEY,
};

/**
 * Who the peek attributes the answer to — the same three states, in the second
 * person (SC-350).
 *
 * Separate from the labels above because those name a source in a filter chip
 * ("By you, here") and this introduces the answer that follows it ("You said").
 * A `repair` row must not read "You said": he said the opposite, and the whole
 * point of the third source is that the surface can be disagreed with.
 */
const ANSWER_SOURCE_ATTRIBUTION_KEYS: Record<AnswerSource, string> = {
  user: 'v3.review.answered.attribution.user',
  // Not "You said" (he did not look at this transfer) and not "Scani corrected
  // this to" (nothing was corrected — nobody had answered it). A rule answered
  // it because he marked the destination, and the sentence has to carry both
  // halves or the reader cannot tell which of the two mistakes to look for.
  rule: 'v3.review.answered.attribution.rule',
  repair: 'v3.review.answered.attribution.repair',
  unattributed: 'v3.review.answered.attribution.unattributed',
};

/**
 * Resolved with the HOST's `t`, not handed over as keys.
 *
 * A `V3FilterOption`'s `label` is TEXT — `@scani/ui` renders it verbatim — and
 * these keys live in the app's `v3.` namespace, which the kit's i18next
 * instance never receives (it is forwarded only the `ui.` half). So passing
 * them as `label` put the literal string `v3.review.answered.source.user` in
 * the filter chip and the Refine sheet. Found by looking at the screen: it
 * type-checks either way, which is exactly what the `labelKey` docblock in
 * `lib/data-view.ts` says the surviving mistake would be.
 *
 * Same shape as `extractionOutcomeOptions(t, …)` on Files, and the reason it is
 * a function rather than a constant.
 */
function answerSourceOptions(t: TFunction): { value: string; label: string }[] {
  return Object.entries(ANSWER_SOURCE_LABEL_KEYS).map(([value, key]) => ({
    value,
    label: t(key),
  }));
}

/**
 * Null on a row the reader answered — there is nothing to flag about those.
 *
 * A `repair` row IS flagged, and for the opposite reason to an unattributed one:
 * not because the provenance is unknown but because it is Scani's and the reader
 * has not seen it yet (SC-350). An answer changed on someone's behalf that says
 * nothing about having been changed is the whole problem restated.
 */
function unrecordedNote(t: TFunction, item: AnsweredTransferReview): string | null {
  if (item.answerSource === 'unattributed') return t(ANSWER_SOURCE_UNRECORDED_KEY);
  if (item.answerSource === 'repair') return t('v3.review.answered.source.repairNote');
  // A rule answer is flagged for the same reason a repair is — the reader has
  // not seen it — and it names the rule, because "answered by a rule" is a
  // provenance while "answered by the rule you wrote calling this your Bybit
  // deposit" is something they can check. SC-345's whole finding is that three
  // years later the address means nothing and the note is all there is.
  if (item.answerSource === 'rule') {
    return item.ruleNote
      ? t('v3.review.answered.source.ruleNote', { note: item.ruleNote })
      : t('v3.review.answered.source.ruleNoteUnnamed');
  }
  return null;
}

function ReopenAction({ item }: { item: AnsweredTransferReview }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const reopen = trpc.transferReview.reopen.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.transferReview.listAnswered.invalidate(),
        utils.transferReview.listPending.invalidate(),
        utils.review.listPending.invalidate(),
      ]);
      setOpen(false);
      // A transfer the owner declared is UNDONE rather than reopened, so both
      // halves of the success have to differ (SC-618): saying "back in the
      // queue" would be false, and sending them to a queue this row will never
      // appear in is the dead end that navigation exists to avoid, reached
      // from the other side.
      if (item.declared) {
        toast({ title: t('v3.review.answered.toast.undone') });
        return;
      }
      toast({ title: t('v3.review.answered.toast.reopened') });
      // Straight to the queue rather than back to a list this row has just
      // left. The reader reopened it in order to answer it differently, and
      // leaving them on a page where it no longer appears is a dead end
      // dressed as a success.
      navigate(TRANSFER_REVIEW_PATH);
    },
    onError: (error) => {
      setOpen(false);
      toast({
        title: t('v3.review.answered.toast.reopenFailed'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
    },
  });

  return (
    <ConfirmAction
      label={t(
        item.declared
          ? 'v3.review.answered.reopen.declaredTrigger'
          : 'v3.review.answered.reopen.trigger'
      )}
      confirmLabel={t(
        item.declared
          ? 'v3.review.answered.reopen.declaredCommit'
          : 'v3.review.answered.reopen.commit'
      )}
      consequence={reopenConsequence(t, item)}
      isPending={reopen.isPending}
      open={open}
      onOpenChange={setOpen}
      onConfirm={() => reopen.mutate({ transactionId: item.transactionId })}
    />
  );
}
