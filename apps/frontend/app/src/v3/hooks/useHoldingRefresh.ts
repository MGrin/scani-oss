import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import type { useHoldingActions } from '@/v2/hooks/useHoldingActions';
import { useJobStatus } from '@/v2/hooks/useJobStatus';
import { describePriceRefresh, type PriceRefreshReport } from '@/v2/lib/priceRefreshOutcome';

/**
 * The two refreshes that are not mutations but jobs, and the toast each one
 * owes when it lands.
 *
 * Price and balance refreshes enqueue on the worker and resolve immediately
 * with a `jobId`; the number on the screen does not move until the job
 * finishes. v2 subscribed to that job from inside `HoldingDetailContent`,
 * which was a page. In v3 the same detail is a **sheet**, and a sheet is
 * closed by the back gesture — so a subscription living there would be
 * unmounted by the user's next tap and the refresh would land silently, with
 * the cache never invalidated and the figure stale until something else
 * refetched it.
 *
 * So the subscription lives here, and the holdings page mounts it once. The
 * sheet only asks; the page is what waits.
 *
 * The busy flag is per-holding rather than global. One sheet is open at a
 * time, but closing one and opening another mid-job is a single gesture, and a
 * global boolean would show the second holding's button spinning for the first
 * one's work.
 */

interface HoldingJob {
  jobId: string;
  holdingId: string;
  /** Upper-cased, and only used to read the balance job's own report of which
   *  symbols the provider actually returned. */
  symbol: string;
}

export interface HoldingRefresh {
  refreshPrice: (holding: { id: string; token: { symbol: string } }) => void;
  refreshBalance: (holding: { id: string; token: { symbol: string } }) => void;
  /** The holding whose price is in flight, or null. */
  refreshingPriceId: string | null;
  refreshingBalanceId: string | null;
}

export function useHoldingRefresh(actions: ReturnType<typeof useHoldingActions>): HoldingRefresh {
  const utils = trpc.useUtils();
  const [priceJob, setPriceJob] = useState<HoldingJob | null>(null);
  const [balanceJob, setBalanceJob] = useState<HoldingJob | null>(null);

  const priceStatus = useJobStatus(priceJob?.jobId ?? null);
  const balanceStatus = useJobStatus(balanceJob?.jobId ?? null);

  const { refreshPriceMutation, refreshBalanceMutation } = actions;

  useEffect(() => {
    if (!priceJob) return;
    if (priceStatus.state === 'completed') {
      // "The job finished" is not "the price moved". A price inside the live
      // window is served from `token_prices` without a provider call — correct,
      // and the right use of the rate-limit budget — but the toast said
      // "BTC price refreshed" over a line that still read `25m ago`, one row
      // below, on the same screen (SC-148). The result now distinguishes the
      // two, so the sentence can.
      const outcome = describePriceRefresh(
        priceStatus.result as PriceRefreshReport | null,
        priceJob.symbol
      );
      if (outcome.kind === 'no-price') showError(new Error(outcome.message), 'Refreshing price');
      else showSuccess(outcome.message);
      setPriceJob(null);
      void invalidatePortfolioQueries(utils);
    } else if (priceStatus.state === 'failed') {
      showError(new Error(priceStatus.error ?? 'Price refresh job failed'), 'Refreshing price');
      setPriceJob(null);
    }
  }, [priceJob, priceStatus.state, priceStatus.result, priceStatus.error, utils]);

  useEffect(() => {
    if (!balanceJob) return;
    if (balanceStatus.state === 'completed') {
      // The venue is asked for the whole account, not for one position, and
      // it can come back without the symbol the user actually pressed —
      // Etherscan's tokentx-based discovery has periodic blind spots. Saying
      // "refreshed" then would be a claim the numbers on the screen disprove.
      const report = balanceStatus.result as
        | { syncedSymbols?: string[]; missingSymbols?: string[] }
        | null
        | undefined;
      const synced = (report?.syncedSymbols ?? []).map((s) => s.toUpperCase());
      const missing = (report?.missingSymbols ?? []).map((s) => s.toUpperCase());
      const { symbol } = balanceJob;

      if (symbol && missing.includes(symbol) && !synced.includes(symbol)) {
        showError(
          new Error(
            `${symbol} wasn't returned by the provider — your other ${synced.length} balance(s) refreshed. Try again in a minute, or re-import the account if this keeps happening.`
          ),
          'Balance refresh — partial'
        );
      } else if (symbol && synced.includes(symbol)) {
        showSuccess(`${symbol} balance refreshed`);
      } else {
        showSuccess(`Refreshed ${synced.length} balance(s) on this account`);
      }
      setBalanceJob(null);
      void invalidatePortfolioQueries(utils);
    } else if (balanceStatus.state === 'failed') {
      showError(new Error(balanceStatus.error ?? 'Refresh job failed'), 'Refreshing balance');
      setBalanceJob(null);
    }
  }, [balanceJob, balanceStatus.state, balanceStatus.result, balanceStatus.error, utils]);

  return {
    refreshPrice: (holding) => {
      // The raw mutation handle rather than `actions.refreshPrice`, because
      // the job has to be tied to the holding it was started for and only the
      // per-call `onSuccess` knows both at once. Reading the shared
      // `mutation.data` in an effect — what v2 does — cannot tell two rapid
      // calls apart.
      refreshPriceMutation.mutate(
        { id: holding.id, requestId: crypto.randomUUID() },
        {
          onSuccess: (data) => {
            if (data?.jobId) {
              setPriceJob({
                jobId: data.jobId,
                holdingId: holding.id,
                symbol: holding.token.symbol.toUpperCase(),
              });
            }
          },
        }
      );
    },
    refreshBalance: (holding) => {
      refreshBalanceMutation.mutate(
        { holdingId: holding.id, requestId: crypto.randomUUID() },
        {
          onSuccess: (data) => {
            if (data?.jobId) {
              setBalanceJob({
                jobId: data.jobId,
                holdingId: holding.id,
                symbol: holding.token.symbol.toUpperCase(),
              });
            }
          },
        }
      );
    },
    refreshingPriceId: priceJob?.holdingId ?? null,
    refreshingBalanceId: balanceJob?.holdingId ?? null,
  };
}
