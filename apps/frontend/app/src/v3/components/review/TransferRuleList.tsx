import type { HiddenTransferReview, TransferReviewRule } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Label } from '@scani/ui/ui/label';
import { useToast } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { formatRelative } from '../../lib/relative-time';

/**
 * The rules in force, and the transfers they are keeping out of the queue
 * (SC-375).
 *
 * Two lists on one page because they are two halves of one claim. A rule that
 * says "stop asking me about this destination" is only trustworthy if the reader
 * can see what it took — a queue that silently drops rows is indistinguishable
 * from one that lost them, and this codebase has spent four separate
 * investigations on a single write nobody could attribute.
 *
 * `affectedCount` is on every rule for the failure this feature is most likely
 * to have: a rule that matches nothing, or matches only the row it was written
 * from, looks exactly like a rule with nothing to do. A rule keyed on the
 ***REMOVED***
 ***REMOVED***
 * first real rule anybody wrote carried the payment amount in its key and
 * could only ever match one row (SC-381).
 *
 * **A marking rule is shown by `answeredCount` instead, and needs both numbers
 * to be honest** (SC-380). One that has done its work has `affectedCount` 0 —
 * nothing waiting — which is byte-identical to the failure above. And the
 * revoke on it is a different operation with a different consequence: revoking
 * stops it answering anything further and leaves every disposal it already
 * booked exactly where it is. A confirmation that did not say so would be the
 * reader walking away from N realized gains believing they had undone them.
 */
export function TransferRuleList({
  rules,
  hidden,
}: {
  rules: TransferReviewRule[];
  hidden: HiddenTransferReview[];
}) {
  const { t } = useTranslation();

  if (rules.length === 0) {
    return (
      <Block className="flex flex-col gap-2 p-4">
        <p className="text-body">{t('v3.review.rules.empty.title')}</p>
        <p className="text-caption text-muted-foreground">{t('v3.review.rules.empty.body')}</p>
      </Block>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {rules.map((rule) => (
        <RuleRow key={rule.id} rule={rule} />
      ))}
      {hidden.length > 0 ? <HiddenList hidden={hidden} /> : null}
    </div>
  );
}

function RuleRow({ rule }: { rule: TransferReviewRule }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  // Off by default, and deliberately so: "stop this rule applying to future
  // transfers" and "everything this rule ever concluded was wrong" are
  // different intentions, and only the second should reopen months of settled
  // answers.
  const [withdrawAnswers, setWithdrawAnswers] = useState(false);
  const marks = rule.verdict === 'always_a_disposal';

  const revoke = trpc.transferReview.rules.revoke.useMutation({
    onSuccess: async (result) => {
      // For the two non-writing verdicts the rows come back on the next read
      // and that is the whole of the undo. For a marking rule the answered list
      // has to be refreshed too — either it just lost N rows, or it did not and
      // the reader is about to be told so.
      await Promise.all([
        utils.transferReview.rules.list.invalidate(),
        utils.transferReview.rules.listHidden.invalidate(),
        utils.transferReview.listPending.invalidate(),
        utils.transferReview.listAnswered.invalidate(),
        utils.review.listPending.invalidate(),
      ]);
      toast({
        title:
          result.withdrawn > 0
            ? t('v3.review.rules.toast.revokedWithdrawn', { count: result.withdrawn })
            : result.answered > 0
              ? t('v3.review.rules.toast.revokedKept', { count: result.answered })
              : t('v3.review.rules.toast.revoked'),
      });
      setOpen(false);
    },
    onError: (error) => {
      toast({
        title: t('v3.review.rules.toast.revokeFailed'),
        description: userFacingMessage(error) ?? undefined,
        variant: 'destructive',
      });
    },
  });

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium">{rule.note}</p>
        {/* The whole key. A rule is revoked by recognising it, and the two
            addresses a reader most needs to tell apart differ in one
            character. */}
        <code className="break-all text-caption text-muted-foreground">
          {rule.matchCounterparty}
        </code>
        <p className="text-caption text-muted-foreground">
          {marks
            ? t('v3.review.rules.row.answering', { count: rule.answeredCount })
            : rule.verdict === 'not_a_disposal'
              ? t('v3.review.rules.row.hiding', { count: rule.affectedCount })
              : t('v3.review.rules.row.labelling', { count: rule.affectedCount })}
          {' · '}
          {formatRelative(t, new Date(rule.createdAt))}
        </p>
      </div>
      <ConfirmAction
        label={t('v3.review.rules.revoke')}
        confirmLabel={t('v3.review.rules.revokeCommit')}
        chooser={
          marks && rule.answeredCount > 0 ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id={`withdraw-${rule.id}`}
                checked={withdrawAnswers}
                onCheckedChange={(next) => setWithdrawAnswers(next === true)}
              />
              <Label htmlFor={`withdraw-${rule.id}`} className="text-caption font-normal">
                {t('v3.review.rules.withdrawAnswers', { count: rule.answeredCount })}
              </Label>
            </div>
          ) : undefined
        }
        consequence={
          marks
            ? withdrawAnswers
              ? t('v3.review.rules.revokeConsequence.markWithdraw', { count: rule.answeredCount })
              : t('v3.review.rules.revokeConsequence.markKeep', { count: rule.answeredCount })
            : rule.verdict === 'not_a_disposal'
              ? t('v3.review.rules.revokeConsequence.notADisposal', { count: rule.affectedCount })
              : t('v3.review.rules.revokeConsequence.askMe')
        }
        isPending={revoke.isPending}
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => revoke.mutate({ ruleId: rule.id, withdrawAnswers })}
      />
    </Block>
  );
}

/**
 * What the rules took.
 *
 * Every row here still has `transfer_review IS NULL` — it is unanswered, not
 * answered by a machine — which is why the page can say the questions are
 * waiting rather than settled.
 */
function HiddenList({ hidden }: { hidden: HiddenTransferReview[] }) {
  const { t } = useTranslation();
  return (
    <Block className="flex flex-col gap-3 p-4">
      <h2 className="text-title">{t('v3.review.rules.hidden.title')}</h2>
      <p className="text-caption text-muted-foreground">{t('v3.review.rules.hidden.body')}</p>
      <ul className="flex flex-col gap-2">
        {hidden.map((row) => (
          <li key={row.transactionId} className="flex flex-col gap-0.5">
            <span className="text-body">
              {row.quantity} {row.tokenSymbol}
            </span>
            <span className="text-caption text-muted-foreground">
              {row.institutionName ? `${row.institutionName} · ` : ''}
              {row.accountName} · {formatRelative(t, new Date(row.occurredAt))} · {row.ruleNote}
            </span>
          </li>
        ))}
      </ul>
    </Block>
  );
}
