import type { PendingTransferReview, TransferReviewRuleVerdict } from '@scani/shared';
import { formatCurrency, TRANSFER_REVIEW_RULE_NOTE_MAX } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { useToast } from '@scani/ui/ui/use-toast';
import type { PeekEndAction } from '@scani/ui/v3/lib/peek';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

/**
 * "Make a rule about this destination" (SC-375, re-keyed by SC-381, given a
 * verdict that answers by SC-380).
 *
 * mgrin's words for the feature were *"if a transaction is to address A, I want
 * to create a rule about all the transfers to that address"*, and the reason it
 * is worth having is his other sentence, about the 560 transfers he had already
 * answered: **"I honestly can not remember that anymore anyway."** The
 * expensive part of this queue was never the tapping. It was being asked what a
 * 42-character hex string meant three years ago.
 *
 * So the required field is the NOTE, not the verdict. A rule whose note is
 * "my Bybit deposit" answers the expensive half of every future question about
 * that address even when its verdict is `ask_me` and it answers nothing.
 *
 * **Authored from a row, never typed.** The destination is not an input here
 * and is not sent — the mutation carries this transaction's id and the server
 * derives the key from the row. The rule key is a field an attacker can write
 * to (address poisoning plants lookalikes in a victim's history), so the
 * reader confirming something the ledger already contains, rather than
 * transcribing it, is the difference between a rule about their money and a
 * rule about somebody else's plant. The whole key is shown, selectable,
 * because the two things a reader must be able to tell apart differ in one
 * character.
 *
 * **Two strings, and both are shown.** SC-381: what this transfer says is
 * `Pay 500.00 USD to Teodor Vance (Dividends)` and what the rule is keyed on
 * is `teodor vance (dividends)`, because the amount is per-payment and a
 * rule carrying it fires once and never again. Showing only the first would
 * make the confirmation above a confirmation of the wrong string — the reader
 * would be agreeing to a rule about this payment while writing one about the
 * person. `counterpartyKey` comes off the same read and is computed by the
 * same SQL the rule engine matches with.
 *
 * **Two of the three verdicts write nothing, and the third books capital
 * gains** (SC-380). That difference is the entire reason the consequence line
 * is computed rather than written: for `ask_me` and `not_a_disposal` it can
 * honestly say nothing is decided, and for `always_a_disposal` it has to say
 * how many transfers are about to be answered and what they will book. A
 * control that said "rule" in the same tone for all three, next to a queue full
 * of taxable decisions, would be the reader consenting to an amount nobody had
 * computed.
 *
 * The marking option is not preselected, is not remembered between transfers,
 * and is not offered at all when the server refuses the destination —
 * `markPreview` reports `own_wallet` for an address in the reader's own
 * `user_wallets`, which is SC-350's ten wrong answers as a standing check.
 *
 * **Where it lives** (SC-1433): the transfer peek's `endAction` row — rare and
 * contextual, rule 4's exception — opening a `FormSheet` like every other
 * create (rule 13). It was a `ConfirmAction` whose chooser held a text field,
 * inside a card in the peek's body. A destination already under a rule shows
 * no row: `RuleNotice` above the answers already carries its note, and the
 * rules themselves are a view of this queue.
 */

/** The peek's end row for a destination with no rule yet, or nothing. */
export function transferRuleEndAction(
  t: ReturnType<typeof useTranslation>['t'],
  item: PendingTransferReview,
  onHidden: () => void
): PeekEndAction | undefined {
  if (item.counterpartyKey === null || item.matchedRule !== null) return undefined;
  return {
    title: t('v3.review.rules.rowTitle'),
    hint: t('v3.review.rules.rowHint'),
    action: <TransferRuleAction item={item} onHidden={onHidden} />,
  };
}

function TransferRuleAction({
  item,
  onHidden,
}: {
  item: PendingTransferReview;
  onHidden: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t('v3.review.rules.trigger')}
      </Button>
      {/* Mounted only while open: the verdict is not remembered between
          transfers, and the mark preview is fetched only for a rule being
          written. */}
      {open ? <TransferRuleSheet item={item} onOpenChange={setOpen} onHidden={onHidden} /> : null}
    </>
  );
}

function TransferRuleSheet({
  item,
  onOpenChange,
  onHidden,
}: {
  item: PendingTransferReview;
  onOpenChange: (open: boolean) => void;
  onHidden: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [verdict, setVerdict] = useState<TransferReviewRuleVerdict>('ask_me');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const key = item.counterpartyKey ?? '';

  const preview = trpc.transferReview.rules.markPreview.useQuery({
    transactionId: item.transactionId,
  });
  const create = trpc.transferReview.rules.create.useMutation({
    onSuccess: async (_data, variables) => {
      await Promise.all([
        utils.transferReview.listPending.invalidate(),
        utils.transferReview.rules.list.invalidate(),
        utils.transferReview.rules.listHidden.invalidate(),
        utils.review.listPending.invalidate(),
      ]);
      toast({ title: t('v3.review.rules.toast.created') });
      onOpenChange(false);
      if (variables.verdict !== 'ask_me') onHidden();
    },
    onError: (error) => setFailure(userFacingMessage(error) ?? t('v3.review.rules.toast.refused')),
  });

  const trimmed = note.trim();
  const mark = preview.data;
  const markRefusal =
    mark?.refusal === 'own_wallet'
      ? t('v3.review.rules.refusal.ownWallet', { key: mark.counterpartyKey })
      : null;
  const canMark = mark != null && mark.refusal === null;
  const effectiveVerdict: TransferReviewRuleVerdict =
    verdict === 'always_a_disposal' && !canMark ? 'ask_me' : verdict;
  const consequence =
    effectiveVerdict === 'always_a_disposal'
      ? markConsequence(t, mark)
      : effectiveVerdict === 'not_a_disposal'
        ? t('v3.review.rules.consequence.notADisposal', { key })
        : t('v3.review.rules.consequence.askMe', { key });

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.review.rules.sheetTitle')}
      description={t('v3.review.rules.sheetDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.review.rules.commit')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={() =>
            create.mutate({
              transactionId: item.transactionId,
              verdict: effectiveVerdict,
              note: trimmed,
            })
          }
          onCancel={() => onOpenChange(false)}
          blockers={trimmed.length > 0 ? [] : [t('v3.review.rules.blocker.note')]}
          pending={create.isPending}
          error={failure}
        />
      }
    >
      {/* What this transfer says, then what the rule will match. Both, because
          after SC-381 they are different strings and the reader is being asked
          to confirm the second one. `dir="ltr"`: a counterparty key is machine
          data carrying bidi-neutral separators, and under `dir="rtl"` the
          segments either side of one swap places (SC-201). */}
      {item.counterparty !== null && item.counterparty !== key ? (
        <Field label={t('v3.review.rules.field.counterparty')}>
          <code dir="ltr" className="break-all text-caption text-muted-foreground">
            {item.counterparty}
          </code>
        </Field>
      ) : null}
      {/* Every character, selectable, and in that order. The truncated form the
          list renders is twelve characters two addresses can share. */}
      <Field
        label={t('v3.review.rules.field.key')}
        hint={item.counterparty !== key ? t('v3.review.rules.field.keyHint') : undefined}
      >
        <code dir="ltr" className="break-all text-caption">
          {key}
        </code>
      </Field>
      <Field label={t('v3.review.rules.field.note')} htmlFor={`rule-note-${item.transactionId}`}>
        <Input
          id={`rule-note-${item.transactionId}`}
          value={note}
          maxLength={TRANSFER_REVIEW_RULE_NOTE_MAX}
          placeholder={t('v3.review.rules.field.notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <Field label={t('v3.review.rules.field.verdict')} hint={markRefusal ?? consequence}>
        {/* A column, as every set of translated sentence-long answers is. */}
        <Segmented
          orientation="vertical"
          value={verdict}
          onValueChange={(next) => setVerdict(next as TransferReviewRuleVerdict)}
          aria-label={t('v3.review.rules.field.verdict')}
        >
          <SegmentedItem value="ask_me">{t('v3.review.rules.verdict.askMe')}</SegmentedItem>
          <SegmentedItem value="not_a_disposal">
            {t('v3.review.rules.verdict.notADisposal')}
          </SegmentedItem>
          {/* Absent, not disabled, when the server would refuse it. The refusal
              is about the destination and not about this control, and it is
              stated below in words rather than left as a control that does
              nothing when tapped. */}
          {canMark ? (
            <SegmentedItem value="always_a_disposal">
              {t('v3.review.rules.verdict.alwaysADisposal')}
            </SegmentedItem>
          ) : null}
        </Segmented>
      </Field>
      {markRefusal ? <p className="text-caption text-muted-foreground">{consequence}</p> : null}
    </FormSheet>
  );
}

function markConsequence(
  t: ReturnType<typeof useTranslation>['t'],
  mark:
    | {
        affectedCount: number;
        proceedsInBase: string | null;
        unpricedCount: number;
        baseCurrencyCode: string;
      }
    | undefined
): string {
  if (!mark || mark.affectedCount === 0) return t('v3.review.rules.consequence.markFuture');
  const proceeds = mark.proceedsInBase
    ? formatCurrency(mark.proceedsInBase, mark.baseCurrencyCode)
    : null;
  const base = proceeds
    ? t('v3.review.rules.consequence.mark', { count: mark.affectedCount, proceeds })
    : t('v3.review.rules.consequence.markUnpriced', { count: mark.affectedCount });
  return mark.unpricedCount > 0 && proceeds
    ? `${base} ${t('v3.review.rules.consequence.markUnpricedTail', { count: mark.unpricedCount })}`
    : base;
}
