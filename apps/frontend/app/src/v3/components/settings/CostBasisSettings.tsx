import type { CostBasisMethodDto } from '@scani/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Loader2, Scale } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { useJobStatus } from '@/v3/hooks/useJobStatus';
import {
  costBasisChangeRequest,
  costBasisMethodLabel,
  costBasisMethodOptions,
} from '../../lib/costBasis';

/**
 * Which rule the account's gains are worked out under — shown, and changeable
 * behind a confirmation that says what changing it does (SC-980).
 *
 * ## Why this is not a field in `ProfileSettings`
 *
 * That block auto-saves a second after the last keystroke. Everything in it
 * can afford to: a name is a name, and a base-currency switch re-denominates
 * figures without rewriting any. This one cannot. A change here busts the live
 * valuation cache and enqueues a backfill across the whole
 * `PORTFOLIO_HISTORY_LOOKBACK_DAYS` window, and every `portfolio_value_daily`
 * row it touches carries cost basis and realized PnL — so a select that saved
 * itself on a timer would rewrite a year of a reader's recorded gains while
 * they were still deciding. Before this block existed the method could only be
 * changed by calling the API, which nobody does by accident; a one-tap toggle
 * would have been a REGRESSION on that, not an improvement.
 *
 * So: its own block, no auto-save, and the commit sits behind `ConfirmAction`
 * where the sentence naming the consequence is what the reader reads before
 * the button to do it exists at all.
 *
 * ## Not `destructive`
 *
 * `ConfirmAction`'s own rule: the red commit is for actions with no inverse,
 * and colouring a reversible one as if it were spends the signal that makes
 * Delete-all-my-data legible three blocks below. A method change is
 * deterministic and reversible — switching back recomputes the same figures
 * again from the same transactions — so what it needs is a sentence, which it
 * has, rather than a colour.
 *
 * ## The running state comes from the SERVER
 *
 * `recomputingJobId` is read back from `users.getCostBasisMethod`, not held
 * from the mutation's reply. The failure this block exists to avoid is a page
 * that reads as finished while the numbers are still moving, and a job id kept
 * in React state is lost by a reload — which is precisely the moment the page
 * would say nothing and be wrong. Held server-side it survives the reload, a
 * second tab, and a different device.
 */
export function CostBasisSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  const stateQuery = trpc.users.getCostBasisMethod.useQuery();
  const state = stateQuery.data;

  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<CostBasisMethodDto | null>(null);

  const update = trpc.users.updateCurrent.useMutation({
    onSuccess: () => {
      setOpen(false);
      setChosen(null);
      // The state query is what hands back the job id the banner below is
      // drawn from, so this is not bookkeeping — without it the rewrite runs
      // with nothing on screen saying so.
      void utils.users.getCostBasisMethod.invalidate();
      // The live valuation cache was busted server-side before this resolved,
      // so what is cached in this tab is already stale. The rollup rows keep
      // moving until the job below reports back.
      void invalidatePortfolioQueries(utils, { refetchType: 'all' });
    },
    onError: (error) => showError(error, t('v3.settings.pending.changingCostBasis')),
  });

  const jobId = state?.recomputingJobId ?? null;
  const status = useJobStatus(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (status.state !== 'completed' && status.state !== 'failed') return;
    // Both terminal states clear the banner, and a failure is not toasted
    // here: the figures are stale rather than wrong, the nightly rollup and
    // the next mutation catch up, and this block is not where a reader who
    // came to read their method would act on it.
    void utils.users.getCostBasisMethod.invalidate();
    if (status.state === 'completed') {
      void invalidatePortfolioQueries(utils, { refetchType: 'all' });
    }
  }, [jobId, status.state, utils]);

  if (!state) return null;

  const requested = costBasisChangeRequest(state.method, chosen);
  const recomputing = jobId !== null;
  const current = costBasisMethodLabel(t, state.method);

  /**
   * What the reader is told will happen, before the button that does it exists.
   *
   * Computed here rather than inline in the JSX for a mechanical reason worth
   * stating: `tests/lib/i18n-keys.test.ts` reads a `t()` call site to decide
   * whether a key is pluralised, and it reads at most the three lines a wrapped
   * call occupies. A call broken across a dozen lines by a comment reads as
   * un-pluralised, the bare `v3.settings.costBasis.consequence` is correctly
   * absent from `en.json`, and the guard reports a missing key over a call that
   * is right. Keeping the call compact keeps the guard able to see it.
   *
   * `count` is FIRST in the object for the same reason: that reader stops at
   * the first `)` it meets, so a `costBasisMethodLabel(t, requested)` ahead of
   * it hides the count behind a closing paren that belongs to something else.
   *
   * `count` is the pluralising name and nothing else will do: with any other
   * name i18next never reaches `consequence_one`/`_other`, resolves the bare
   * key, finds nothing, and renders the KEY ITSELF onto the confirmation. That
   * is not hypothetical — it is what this shipped as until it was driven in a
   * browser, and type-check, lint and every test here were green over it.
   *
   * The day count comes from the server so the sentence cannot claim a window
   * the job does not actually rewrite.
   */
  const consequence = requested
    ? t('v3.settings.costBasis.consequence', {
        count: state.lookbackDays,
        method: costBasisMethodLabel(t, requested),
      })
    : t('v3.settings.costBasis.consequenceUnchanged', { method: current });

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.costBasis.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.costBasis.intro')}</p>
        {/* The answer to "which rule are my figures under", stated as a fact
            rather than drawn as a form control — the same reasoning as the
            read-only email in `ProfileSettings`. Changing it is the button
            below, and it is deliberately a different act from reading it. */}
        <p className="text-body">{t('v3.settings.costBasis.current', { method: current })}</p>
      </div>

      {recomputing ? (
        // `aria-live`, because the whole point of this line is that it appears
        // without the reader having done anything — it is also here on a page
        // they merely reloaded mid-rewrite.
        <p
          aria-live="polite"
          className="flex items-center gap-2 text-caption text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('v3.settings.costBasis.recomputing')}
        </p>
      ) : null}

      <ConfirmAction
        label={
          <>
            <Scale className="me-2 size-4" aria-hidden="true" />
            {t('v3.settings.costBasis.changeTrigger')}
          </>
        }
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Cancel drops the choice with it. A chooser that remembered last
          // time's selection would re-open already pointing at a change the
          // reader declined.
          if (!next) setChosen(null);
        }}
        chooser={
          <Select
            value={chosen ?? state.method}
            onValueChange={(value) => setChosen(value as CostBasisMethodDto)}
          >
            <SelectTrigger
              aria-label={t('v3.settings.costBasis.chooserLabel')}
              className="text-body"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {costBasisMethodOptions(t).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        consequence={consequence}
        canConfirm={requested !== null}
        confirmLabel={t('v3.settings.costBasis.changeConfirm', {
          method: costBasisMethodLabel(t, requested ?? state.method),
        })}
        isPending={update.isPending}
        disabledReason={recomputing ? t('v3.settings.costBasis.changeInFlight') : undefined}
        onConfirm={() => {
          if (!requested) return;
          update.mutate({ costBasisMethod: requested });
        }}
      />
    </Block>
  );
}
