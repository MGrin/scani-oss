import type { PendingTransferReview, TransferReviewRuleVerdict } from '@scani/shared';
import { formatCurrency, TRANSFER_REVIEW_RULE_NOTE_MAX } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { useToast } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { TRANSFER_RULES_PATH } from '../../lib/routes';

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
 * `Pay 500.00 USD to Nikita Grishin (Dividends)` and what the rule is keyed on
 * is `nikita grishin (dividends)`, because the amount is per-payment and a
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
 */
export function TransferRuleAction({
  item,
  onHidden,
}: {
  item: PendingTransferReview;
  /**
   * Called when the rule just written takes this transfer out of the queue, so
   * the sheet can close back to the list.
   *
   * Not for `ask_me`, which leaves the row exactly where it was and still
   * unanswered — closing on that one would take away a question the reader has
   * not answered yet. The other two both remove it: `not_a_disposal` hides it
   * and `always_a_disposal` answers it. Without this the sheet stayed open over
   * a row that had left the list and rendered "This transfer is not on this
   * list" — true, and a strange thing to be told about something you just
   * filed.
   */
  onHidden: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<TransferReviewRuleVerdict>('ask_me');
  const [note, setNote] = useState('');

  // Loaded whenever the sheet is open rather than on selecting the marking
  // option, because the option itself has to be able to say why it is
  // unavailable. A preview that only appears after the reader picks the
  // dangerous choice teaches them nothing before they pick it.
  const preview = trpc.transferReview.rules.markPreview.useQuery(
    { transactionId: item.transactionId },
    { enabled: open }
  );

  const create = trpc.transferReview.rules.create.useMutation({
    onSuccess: async (_data, variables) => {
      await Promise.all([
        utils.transferReview.listPending.invalidate(),
        utils.transferReview.rules.list.invalidate(),
        utils.transferReview.rules.listHidden.invalidate(),
        utils.review.listPending.invalidate(),
      ]);
      toast({ title: t('v3.review.rules.toast.created') });
      setOpen(false);
      setNote('');
      // Both of these take the row out of the queue, for opposite reasons: one
      // hid it, the other answered it. Either way the sheet is now open over a
      // transfer that is not on the list behind it.
      if (variables.verdict !== 'ask_me') onHidden();
    },
    onError: (error) => {
      toast({
        title: t('v3.review.rules.toast.refused'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
    },
  });

  // Nothing to key a rule on. 202 of 470 production outflows are in this state
  // — a Kraken withdrawal record does not say where the money went, and Solana
  // rows carry no payload at all — so the control is absent rather than
  // present and refusing. Keyed on `counterpartyKey` and not `counterparty`,
  // because that is the field `rules.create` refuses on.
  if (item.counterpartyKey === null) return null;

  // The destination already has one. Offering "make a rule" here would produce
  // a conflict the reader cannot act on from this screen, so it points at the
  // rule instead — which is also where the undo is.
  if (item.matchedRule !== null) {
    return (
      <Block className="flex flex-col gap-2 p-4">
        <p className="text-caption text-muted-foreground">{t('v3.review.rules.alreadyRuled')}</p>
        <p className="text-body">{item.matchedRule.note}</p>
        <Link to={TRANSFER_RULES_PATH} className="text-label text-muted-foreground underline">
          {t('v3.review.rules.manage')}
        </Link>
      </Block>
    );
  }

  const trimmed = note.trim();
  const mark = preview.data;
  // Only `own_wallet` is worth a sentence here. `no_counterparty` cannot happen
  // — the control is absent above for exactly that row — and `duplicate` is
  // handled by the `matchedRule` branch, so the surface never has to explain
  // it twice.
  const markRefusal =
    mark?.refusal === 'own_wallet'
      ? t('v3.review.rules.refusal.ownWallet', { key: mark.counterpartyKey })
      : null;
  const canMark = mark != null && mark.refusal === null;
  // Selecting a verdict the preview then withdraws would leave the reader
  // confirming a consequence for an option no longer on screen.
  const effectiveVerdict: TransferReviewRuleVerdict =
    verdict === 'always_a_disposal' && !canMark ? 'ask_me' : verdict;

  return (
    <Block className="flex flex-col gap-3 p-4">
      <ConfirmAction
        label={t('v3.review.rules.trigger')}
        confirmLabel={t('v3.review.rules.commit')}
        chooser={
          <div className="flex flex-col gap-3">
            {/* What this transfer says, then what the rule will match. Both,
                because after SC-381 they are different strings and the reader
                is being asked to confirm the second one. */}
            {item.counterparty !== null && item.counterparty !== item.counterpartyKey ? (
              <div className="flex flex-col gap-1">
                <span className="text-caption text-muted-foreground">
                  {t('v3.review.rules.field.counterparty')}
                </span>
                <code className="break-all text-caption text-muted-foreground">
                  {item.counterparty}
                </code>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <span className="text-caption text-muted-foreground">
                {t('v3.review.rules.field.key')}
              </span>
              {/* Every character, selectable. The truncated form the list
                  renders is twelve characters two addresses can share. */}
              <code className="break-all text-caption">{item.counterpartyKey}</code>
              {item.counterparty !== item.counterpartyKey ? (
                <span className="text-caption text-muted-foreground">
                  {t('v3.review.rules.field.keyHint')}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rule-note-${item.transactionId}`}>
                {t('v3.review.rules.field.note')}
              </Label>
              <Input
                id={`rule-note-${item.transactionId}`}
                value={note}
                maxLength={TRANSFER_REVIEW_RULE_NOTE_MAX}
                placeholder={t('v3.review.rules.field.notePlaceholder')}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <Segmented
              value={verdict}
              onValueChange={(next) => setVerdict(next as TransferReviewRuleVerdict)}
              aria-label={t('v3.review.rules.field.verdict')}
            >
              <SegmentedItem value="ask_me">{t('v3.review.rules.verdict.askMe')}</SegmentedItem>
              <SegmentedItem value="not_a_disposal">
                {t('v3.review.rules.verdict.notADisposal')}
              </SegmentedItem>
              {/* Absent, not disabled, when the server would refuse it. The
                  refusal is about the destination and not about this control,
                  and it is stated below in words rather than left as a control
                  that does nothing when tapped. */}
              {canMark ? (
                <SegmentedItem value="always_a_disposal">
                  {t('v3.review.rules.verdict.alwaysADisposal')}
                </SegmentedItem>
              ) : null}
            </Segmented>
            {markRefusal ? (
              <p className="text-caption text-muted-foreground">{markRefusal}</p>
            ) : null}
          </div>
        }
        consequence={
          effectiveVerdict === 'always_a_disposal'
            ? markConsequence(t, mark)
            : effectiveVerdict === 'not_a_disposal'
              ? t('v3.review.rules.consequence.notADisposal', { key: item.counterpartyKey })
              : t('v3.review.rules.consequence.askMe', { key: item.counterpartyKey })
        }
        canConfirm={trimmed.length > 0 && (effectiveVerdict !== 'always_a_disposal' || canMark)}
        isPending={create.isPending}
        open={open}
        onOpenChange={setOpen}
        onConfirm={() =>
          create.mutate({
            transactionId: item.transactionId,
            verdict: effectiveVerdict,
            note: trimmed,
          })
        }
      />
    </Block>
  );
}

/**
 * The sentence a marking confirmation has to say, in money.
 *
 * Three shapes rather than one, because the reader is authorizing three
 * different things and only one of them is the interesting case. Marking a
 * destination with nothing waiting is a standing sentence about the future and
 * says so. Marking one where no transfer has a price on its day books nothing
 * today and must not imply an amount. The middle case names the count and the
 * proceeds, and names the unpriced remainder separately rather than folding it
 * in as a zero — "we have no price that day" and "it was worth nothing" are
 * different claims and only one of them is checkable.
 */
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
