import { HOLDING_LABEL_MAX_LENGTH } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AccountTargetFields } from '../components/capture/AccountTargetFields';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { TokenField } from '../components/capture/TokenField';
import { Field, FieldRow, FieldSet } from '../components/form/Field';
import { useAccountTarget } from '../hooks/useAccountTarget';
import {
  buildHoldingsBatchInput,
  contestedHoldingTokenIds,
  describeManualEntryBlockers,
  emptyHolding,
  type HoldingDraft,
} from '../lib/manual-entry';
import { jobDetailPath } from '../lib/routes';

/**
 * Typing holdings in by hand — the fallback the capture sheet offers when
 * none of the other five routes fit, and the largest page in v2 at 659 lines.
 *
 * It is smaller here because things left it rather than because anything was
 * dropped. The 137-line `SearchableDropdown` defined inside the file is now
 * `RecordPicker` (V3-13), shared with the payment form. The submit gate — five
 * booleans `&&`ed into a grey button — is `describeManualEntryBlockers`, which
 * says what is missing instead. And the whole "where" half is
 * `useAccountTarget` + `AccountTargetFields` (V3-44), because the file import
 * asks precisely the same question and two copies of "picking an account fills
 * in its institution" is one copy too many.
 *
 * What is left is the form's own shape, and every measurement in it is the v3
 * convention: 14px labels over 16px controls (`<Field>`), pairs that stack
 * below `lg` rather than sharing a phone-width row (`<FieldRow>`), `<Block>`
 * per section with a muted heading rather than a `Card` with a title that
 * competes with the labels underneath it.
 *
 * The write is still an enqueue. `batchOperations.createHoldingsBatch` hands
 * the whole thing to the worker, which creates the institution, the account and
 * the holdings and then prices each one — so the form ends on the job's page
 * rather than on a list of un-priced rows. That page was v2's until V3-15 built
 * it; V3-44 pointed this line at the v3 one, which is the last thing V3-14 left
 * borrowed here.
 */
export function ManualEntryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const target = useAccountTarget();

  const [holdings, setHoldings] = useState<HoldingDraft[]>(() => [
    emptyHolding(crypto.randomUUID()),
  ]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Deduplication key for the enqueue, stable for the life of the form.
   * The worker folds it into the job id, so a double-tap on a slow connection
   * creates one set of holdings rather than two. Regenerated on mount, so
   * leaving and coming back is a new submission rather than a silent no-op.
   */
  const requestId = useMemo(() => crypto.randomUUID(), []);

  const createMutation = trpc.batchOperations.createHoldingsBatch.useMutation({
    // The job's own page is where "did it work" is answered.
    onSuccess: ({ jobId }) => navigate(jobDetailPath(jobId)),
    onError: (err) => {
      const copy = describeQueryError(err, t('v3.capture.page.manual.subject'));
      setError(`${copy.title}. ${copy.detail}`);
    },
  });

  const isSaving = createMutation.isPending;
  const draft = { ...target.draft, holdings };

  const contestedTokens = contestedHoldingTokenIds(holdings);

  const patchHolding = (uid: string, next: Partial<HoldingDraft>) =>
    setHoldings((current) =>
      current.map((holding) => (holding.uid === uid ? { ...holding, ...next } : holding))
    );

  const handleSubmit = () => {
    const input = buildHoldingsBatchInput(draft, requestId);
    if (!input || isSaving) return;
    setError(null);
    createMutation.mutate(input);
  };

  const canRemoveHolding = holdings.length > 1;

  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.capture.page.manual.title')}
        description={t('v3.capture.page.manual.description')}
      />

      <Block>
        <AccountTargetFields target={target} disabled={isSaving} />
      </Block>

      <Block>
        <FieldSet title={t('v3.capture.page.manual.fieldset')}>
          <div className="flex flex-col divide-y divide-border">
            {holdings.map((holding, index) => (
              <FieldRow key={holding.uid} className="py-3 first:pt-0">
                <Field
                  label={t('v3.capture.page.manual.token')}
                  htmlFor={`manual-token-${holding.uid}`}
                >
                  <TokenField
                    inputId={`manual-token-${holding.uid}`}
                    ariaLabel={t('v3.capture.page.manual.tokenFor', { index: index + 1 })}
                    value={
                      holding.tokenId ? { id: holding.tokenId, label: holding.tokenLabel } : null
                    }
                    onSelect={(tokenId, tokenLabel) =>
                      patchHolding(holding.uid, { tokenId, tokenLabel })
                    }
                    onClear={() => patchHolding(holding.uid, { tokenId: '', tokenLabel: '' })}
                    disabled={isSaving}
                  />
                </Field>

                <Field
                  label={t('v3.capture.page.manual.amount')}
                  htmlFor={`manual-balance-${holding.uid}`}
                >
                  <div className="flex gap-2">
                    <AmountInput
                      id={`manual-balance-${holding.uid}`}
                      value={holding.balance}
                      onValueChange={(balance) => patchHolding(holding.uid, { balance })}
                      placeholder="0.00"
                      decimalScale={8}
                      disabled={isSaving}
                      wrapperClassName="min-w-0 flex-1"
                      className="text-body"
                    />
                    {canRemoveHolding ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground"
                        aria-label={t('v3.capture.page.manual.removeHolding', { index: index + 1 })}
                        disabled={isSaving}
                        onClick={() =>
                          setHoldings((current) => current.filter((row) => row.uid !== holding.uid))
                        }
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </Field>

                {/* Only on rows whose token this form names more than once —
                    a bank screen with several pots of one currency. Every
                    other entry is untouched, so this is not a field everyone
                    learns to scroll past (SC-63, SC-73). */}
                {contestedTokens.has(holding.tokenId) ? (
                  <Field
                    label={t('v3.capture.page.manual.potName')}
                    htmlFor={`manual-label-${holding.uid}`}
                    hint={t('v3.capture.page.manual.potNameHint')}
                  >
                    <Input
                      id={`manual-label-${holding.uid}`}
                      value={holding.label}
                      maxLength={HOLDING_LABEL_MAX_LENGTH}
                      onChange={(event) => patchHolding(holding.uid, { label: event.target.value })}
                      placeholder={t('v3.capture.page.manual.potNamePlaceholder')}
                      disabled={isSaving}
                    />
                  </Field>
                ) : null}
              </FieldRow>
            ))}
          </div>

          <Button
            variant="outline"
            className="self-start"
            disabled={isSaving}
            onClick={() =>
              setHoldings((current) => [...current, emptyHolding(crypto.randomUUID())])
            }
          >
            <Plus className="mr-1.5 size-4" aria-hidden="true" />
            {t('v3.capture.page.manual.addAnother')}
          </Button>
        </FieldSet>
      </Block>

      <CaptureSubmit
        label={t('v3.capture.page.manual.save')}
        blockers={describeManualEntryBlockers(t, draft)}
        onSubmit={handleSubmit}
        stage={isSaving ? 'enqueue' : null}
        busyLabel="the save"
        error={error}
      />
    </PageLayout>
  );
}
