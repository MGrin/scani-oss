import { formatDateTime, HOLDING_LABEL_MAX_LENGTH, quantityDecimals } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { Check, CheckCircle2, Circle, Loader2, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import {
  buildBatchPayload,
  deriveReviewState,
  type ReviewHoldingInput,
  type ReviewRow,
  toReviewRows,
} from '../../lib/review-holdings';
import { jobDetailPath, V3_ROUTES } from '../../lib/routes';
import { TokenField } from '../capture/TokenField';
import { Field } from '../form/Field';

/**
 * The confirm step for holdings a parser extracted — the screen the whole
 * `/review` feed exists to reach.
 *
 * Three things are different from v2's card, and all three are corrections
 * rather than restyling:
 *
 * - **The button's number is the number that gets written.** v2 counts matched
 *   rows in the header and the label, then filters those again on a truthy
 *   `balance` inside the save. Clear one row's amount and it still says "Import
 *   2 holdings", still enables, and writes one. The count and the payload now
 *   come from one `deriveReviewState`, and a row with no amount blocks the save
 *   with a reason instead of disappearing out of it.
 * - **A refusal says what to do.** A disabled button that explains nothing is
 *   the pattern slices 2 and 4 removed from the other v3 forms.
 * - **The already-imported card claims no number.** v2 says "{n} holdings from
 *   this screenshot were confirmed and saved", reading `n` off the EXTRACTED
 *   list — so a reader who removed three rows before importing is told on every
 *   later visit that all five were saved. What was actually written is recorded
 *   on the `manual-holdings-create` job this one hands off to, not here, so
 *   this states the fact it has and stops.
 *
 * Scope is v2's, deliberately: this needs an `accountId` already on the job.
 * The create-an-account-inline path lives on the upload page because its state
 * is not durably persisted on the job record.
 */

interface ReviewHoldingsCardProps {
  accountId: string;
  holdings: readonly ReviewHoldingInput[];
  /** Which pill the block wears, and which sentence the discarded/imported
   *  states use. A discriminant, never a noun spliced into a sentence. */
  source: 'screenshot' | 'statement' | 'files';
  overallConfidence?: number | null;
  /** Stamps `user_jobs.action_taken_at` on this job when the import succeeds,
   *  so revisits render read-only. */
  jobId?: string;
  /** Existing stamp, if any — flips the card into read-only mode. */
  actionTakenAt?: Date | string | null;
}

export function ReviewHoldingsCard({
  accountId,
  holdings,
  source,
  overallConfidence,
  jobId,
  actionTakenAt,
}: ReviewHoldingsCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [rows, setRows] = useState<ReviewRow[]>(() => toReviewRows(holdings));
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const createBatch = trpc.batchOperations.createHoldingsBatch.useMutation({
    onError: (error) => {
      // Inline, not a toast. A four-second banner over the tab bar is gone
      // before a reader has finished reading the row it refers to (SC-320
      // slice 3), and this failure leaves a form they have to act on.
      const copy = describeQueryError(error, t('v3.jobs.review.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSuccess: ({ jobId: importJobId }) => navigate(jobDetailPath(importJobId)),
  });

  const state = useMemo(() => deriveReviewState(rows), [rows]);
  const isSaving = createBatch.isPending;

  const patch = (rowId: string, changes: Partial<ReviewRow>) =>
    setRows((prev) => prev.map((row) => (row.rowId === rowId ? { ...row, ...changes } : row)));

  const save = () => {
    const payload = buildBatchPayload(state, {
      accountId,
      jobId,
      requestId: crypto.randomUUID(),
    });
    // Null only when a blocker is set, and a blocker disables the button. The
    // guard is here so the two can never be reasoned about separately.
    if (!payload) return;
    setFailure(null);
    createBatch.mutate(payload);
  };

  // After every hook, so the hook order stays stable across renders.
  if (actionTakenAt) {
    const when = actionTakenAt instanceof Date ? actionTakenAt : new Date(String(actionTakenAt));
    const whenLabel = Number.isNaN(when.getTime()) ? null : formatDateTime(when);
    return (
      <Block className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-title">{t('v3.jobs.review.imported.title')}</h2>
        </div>
        {whenLabel ? (
          <p className="text-caption text-muted-foreground">
            {t('v3.jobs.review.imported.when', { when: whenLabel })}
          </p>
        ) : null}
        <p className="text-body text-muted-foreground">{t('v3.jobs.review.imported.body')}</p>
        <Button asChild variant="outline" className="mt-1 self-start">
          <Link to={V3_ROUTES.holdings}>{t('v3.jobs.review.viewHoldings')}</Link>
        </Button>
      </Block>
    );
  }

  return (
    <Block className="flex flex-col">
      <BlockHeader title={t('v3.jobs.review.title')} />
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Badge variant="outline">{t(`v3.jobs.review.source.${source}`)}</Badge>
        <span className="text-caption text-muted-foreground">
          {t('v3.jobs.review.willImport', { count: state.importableCount })}
        </span>
        {typeof overallConfidence === 'number' ? (
          <Badge variant="secondary">
            {t('v3.jobs.review.confidence', { percent: Math.round(overallConfidence * 100) })}
          </Badge>
        ) : null}
      </div>

      <ul className="flex flex-col border-t border-border">
        {rows.map((row) => {
          const isUpdate = Boolean(row.holdingId);
          const isMatched = Boolean(row.tokenId);
          const isEditing = editingRowId === row.rowId;
          // Asked only on rows whose token this payload puts on more than one
          // row — rare, and the reason it is not a confirmation that appears
          // every time and stops being read (SC-63, SC-73).
          const needsName =
            !row.removed &&
            !isUpdate &&
            isMatched &&
            state.contestedTokenIds.has(row.tokenId ?? '');

          return (
            <li
              key={row.rowId}
              className={`flex flex-col gap-2 border-b border-border p-4 last:border-b-0 lg:flex-row lg:items-start ${
                row.removed ? 'opacity-50' : ''
              }`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {isEditing ? (
                  <div className="flex flex-col gap-2">
                    <TokenField
                      inputId={`swap-${row.rowId}`}
                      ariaLabel={t('v3.jobs.review.row.searchLabel', { symbol: row.symbol })}
                      value={null}
                      onSelect={(tokenId, _label, details) => {
                        // Clearing `holdingId` flips an update back to a fresh
                        // create: the holding it pointed at belongs to the
                        // token that was just replaced.
                        patch(row.rowId, {
                          tokenId,
                          symbol: details.symbol,
                          name: details.name,
                          holdingId: null,
                          existingBalance: null,
                          existingLabel: null,
                        });
                        setEditingRowId(null);
                      }}
                      onClear={() => setEditingRowId(null)}
                      disabled={isSaving}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={() => setEditingRowId(null)}
                      disabled={isSaving}
                    >
                      {t('v3.jobs.review.row.keepToken', { symbol: row.symbol })}
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {isMatched && !row.removed ? (
                      <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <Circle
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <span className="text-body font-medium">{row.symbol}</span>
                    {row.name && row.name !== row.symbol ? (
                      <span className="min-w-0 truncate text-caption text-muted-foreground">
                        {row.name}
                      </span>
                    ) : null}
                    {row.assetType ? (
                      <Badge variant="secondary" className="capitalize">
                        {t(`v3.jobs.review.assetType.${row.assetType}`)}
                      </Badge>
                    ) : null}
                    {!row.removed && isMatched ? (
                      <Badge variant="outline">
                        {isUpdate ? t('v3.jobs.review.row.update') : t('v3.jobs.review.row.new')}
                      </Badge>
                    ) : null}
                    {!row.removed ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingRowId(row.rowId)}
                        aria-label={t('v3.jobs.review.row.changeToken', { symbol: row.symbol })}
                        disabled={isSaving}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                )}

                {/* Which pot this line was matched to. The match is by order
                    within a token, so on an account holding several it is a
                    guess, and the stored name is what lets a reader see the
                    guess was wrong before saving (SC-330). v2 renders this row
                    too — but the only path that reaches it drops `existingLabel`
                    on the way, so the half that identifies the pot has never
                    appeared on screen. */}
                {isUpdate && row.existingBalance && !row.removed && !isEditing ? (
                  <p className="flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
                    <span>{t('v3.jobs.review.row.currentLabel')}</span>
                    {/* Through `Numeric` at `quantityDecimals`, not interpolated
                        into the sentence: `existingBalance` arrives as the raw
                        ***REMOVED***
                        ***REMOVED***
                        formats. */}
                    <Numeric
                      value={row.existingBalance}
                      format="plain"
                      decimals={quantityDecimals(row.existingBalance)}
                    />
                    {row.existingLabel ? <span>· {row.existingLabel}</span> : null}
                  </p>
                ) : null}

                {/* A labelled `Field`, not a bare box with a placeholder in it.
                    The field appears whenever the token is CONTESTED, which is
                    before anything has gone wrong — so at the moment it first
                    renders there is no blocker line on screen explaining it,
                    and an unlabelled box saying "e.g. Savings" under a RUB row
                    is a question the reader has to reverse-engineer. Capped in
                    width for the same reason `FieldRow` exists: a pot name is
                    two words, and a 970px input for it reads as a mistake. */}
                {needsName && !isEditing ? (
                  <Field
                    label={t('v3.jobs.review.row.nameLabel', { symbol: row.symbol })}
                    htmlFor={`name-${row.rowId}`}
                    className="lg:max-w-xs"
                  >
                    <Input
                      id={`name-${row.rowId}`}
                      value={row.label}
                      onChange={(event) => patch(row.rowId, { label: event.target.value })}
                      maxLength={HOLDING_LABEL_MAX_LENGTH}
                      placeholder={t('v3.jobs.review.row.namePlaceholder')}
                      className="text-body"
                      disabled={isSaving}
                    />
                  </Field>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {!row.removed ? (
                  <AmountInput
                    value={row.balance}
                    onValueChange={(balance) => patch(row.rowId, { balance })}
                    decimalScale={8}
                    aria-label={t('v3.jobs.review.row.amountLabel', { symbol: row.symbol })}
                    disabled={isSaving}
                    wrapperClassName="min-w-0 flex-1 lg:w-40 lg:flex-none"
                    className="text-body text-end"
                  />
                ) : null}
                {typeof row.confidence === 'number' ? (
                  <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                    <Numeric
                      value={Math.round(row.confidence * 100)}
                      format="percent"
                      decimals={0}
                    />
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => patch(row.rowId, { removed: !row.removed })}
                  aria-label={
                    row.removed
                      ? t('v3.jobs.review.row.restore', { symbol: row.symbol })
                      : t('v3.jobs.review.row.remove', { symbol: row.symbol })
                  }
                  disabled={isSaving}
                >
                  {row.removed ? (
                    <RotateCcw className="size-4" aria-hidden="true" />
                  ) : (
                    <Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-2 border-t border-border p-4">
        {state.unmatched.length > 0 ? (
          <p className="text-caption text-muted-foreground">
            {t('v3.jobs.review.unmatchedNote', { count: state.unmatched.length })}
          </p>
        ) : null}
        {/* `To continue: …`, the same sentence `FormActions` puts under every
            other blocked v3 submit, and the same treatment: muted, because a
            refusal that explains itself is not an alarm. */}
        {state.blocker ? (
          <p className="text-caption text-muted-foreground">
            {t('v3.form.blockers', {
              blockers:
                state.blocker === 'duplicatePosition'
                  ? t('v3.jobs.review.blocker.duplicatePosition', {
                      symbols: state.collidingSymbols.join(', '),
                    })
                  : state.blocker === 'missingAmount'
                    ? t('v3.jobs.review.blocker.missingAmount', { count: state.incomplete.length })
                    : t('v3.jobs.review.blocker.nothingToImport'),
            })}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-caption text-destructive">
            {failure}
          </p>
        ) : null}
        <Button onClick={save} disabled={state.blocker !== null || isSaving} className="w-full">
          {isSaving ? (
            <>
              <Loader2 className="me-2 size-4 animate-spin" aria-hidden="true" />
              {t('v3.jobs.review.importing')}
            </>
          ) : (
            t('v3.jobs.review.import', { count: state.importableCount })
          )}
        </Button>
      </div>
    </Block>
  );
}
