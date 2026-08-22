import {
  describeJobFailure,
  type ReviewAmount,
  type ReviewDetail,
  type ReviewLabel,
} from '@scani/shared';
import type { TFunction } from 'i18next';
import { jobLabelFor } from './job-labels';
import { jobFailureSentence } from './jobs';
import type { ReviewRow } from './review';

/**
 * How a review row reads — the half the server used to do (SC-371).
 *
 * `review.listPending` sends operands now: a job name, a count, a wallet's own
 * label, the facts of a failure. Everything a reader sees is composed here,
 * because composing it on the server put a copy of these sentences somewhere
 * no `t()` and no string scanner could reach — the same job read
 * `t('v3.jobs.label.walletImport')` on /jobs and the server's `'Wallet import'`
 * on /review.
 *
 * **Both generations render through this one function.** v2 cannot resolve a
 * `v3.*` key — those are registered by the v3 chunk alone, so under `/v2` they
 * would print raw — but it can pass its own English for the same keys, which
 * is what `ReviewTexts` is for: one algorithm, one string table per interface,
 * and `tests/v3/lib/review-text.test.ts` pins the two tables equal so the feed
 * cannot start reading two different ways on two screens. v2's table dies with
 * `src/v2/`; that is the whole reason it is allowed to exist.
 */

/** How many symbols a row names before it says "+3". A 390px decision, which
 *  is why it is here and not in the collector that counted them. */
const MAX_SYMBOLS = 3;

export interface ReviewTexts {
  t: (key: string, vars?: Record<string, unknown>) => string;
  /** Each interface already has its own job-label table — v3's holds `t()`
   *  keys and an icon, v2's holds English and an icon — so the name comes
   *  from the caller rather than being spelled a third time here. */
  jobTitle: (jobName: string) => string;
}

export function v3ReviewTexts(t: TFunction): ReviewTexts {
  return {
    t: (key, vars) => t(key, vars) as string,
    jobTitle: (jobName) => jobLabelFor(t, jobName).label,
  };
}

/** The row as it arrives, before anything has been named. */
export interface ReviewWireRow {
  id: string;
  kind: string;
  label: ReviewLabel;
  detail?: ReviewDetail | null;
  amount?: ReviewAmount | null;
  href: string;
  createdAt: string;
}

export function reviewTitle(texts: ReviewTexts, label: ReviewLabel): string {
  switch (label.code) {
    case 'job':
      return texts.jobTitle(label.jobName);
    case 'jobFailed':
      return texts.t('v3.review.item.jobFailed', { job: texts.jobTitle(label.jobName) });
    case 'invoiceExtracted':
      return texts.t('v3.review.item.invoiceExtracted');
    case 'transfersToConfirm':
      return texts.t('v3.review.item.transfersToConfirm');
    case 'balanceChangesToExplain':
      return texts.t('v3.review.item.balanceChangesToExplain');
  }
}

export function reviewDetailText(
  texts: ReviewTexts,
  detail: ReviewDetail | null | undefined
): string | null {
  if (!detail) return null;
  switch (detail.code) {
    case 'parsedHoldings': {
      const shown = detail.symbols.slice(0, MAX_SYMBOLS).join(', ');
      if (!shown) return texts.t('v3.review.item.holdings', { count: detail.holdings });
      const hidden = detail.symbols.length - MAX_SYMBOLS;
      const symbols =
        hidden > 0 ? texts.t('v3.review.item.symbolsOverflow', { symbols: shown, hidden }) : shown;
      return texts.t('v3.review.item.holdingsWithSymbols', { count: detail.holdings, symbols });
    }
    case 'transactionsNeedCurrency':
      return detail.fileType
        ? texts.t('v3.review.item.needsCurrencyWithType', {
            count: detail.transactions,
            fileType: detail.fileType.toUpperCase(),
          })
        : texts.t('v3.review.item.needsCurrency', { count: detail.transactions });
    case 'walletCandidates': {
      // A sweep that found nothing says so: it explains an otherwise-empty
      // review without the reader opening the job.
      const body =
        detail.candidates === 0
          ? texts.t('v3.review.item.nothingFound')
          : texts.t('v3.review.item.candidatesAcross', {
              count: detail.candidates,
              chains: texts.t('v3.review.item.chains', { count: detail.chains }),
            });
      return detail.walletLabel
        ? texts.t('v3.review.item.labelled', { label: detail.walletLabel, body })
        : body;
    }
    case 'vendor':
      return detail.name;
    case 'unexplainedBalanceChanges':
      return texts.t('v3.review.item.unexplainedBalanceChanges', { count: detail.changes });
    case 'unpairedTransfers':
      return texts.t('v3.review.item.unpairedTransfers', { count: detail.transfers });
    case 'jobFailure': {
      // The one description of a failure, shared with both frontends' job
      // pages — so /review cannot call a dead job something the job's own
      // screen does not. It answers with a code and operands (SC-424), and
      // `jobFailureSentence` is the same naming both job pages use.
      const failure = describeJobFailure(detail.facts);
      return failure ? jobFailureSentence(texts.t, failure) : null;
    }
  }
}

/**
 * A decimal string becomes a number exactly once, here, on its way to
 * `<Numeric>`. v3 used to recover this figure by running a regex over the
 * server's English — `Albert Heijn — 87.31 EUR` — which held for as long as
 * nobody rephrased the sentence.
 */
export function toReviewRow(texts: ReviewTexts, item: ReviewWireRow): ReviewRow {
  const value = item.amount ? Number(item.amount.value) : Number.NaN;
  const title = reviewTitle(texts, item.label);
  const detail = reviewDetailText(texts, item.detail);
  return {
    id: item.id,
    kind: item.kind,
    title,
    detail,
    amount:
      item.amount && Number.isFinite(value) ? { value, currency: item.amount.currency } : null,
    // The digits as they were recorded, not as a float would print them: the
    // subtitle this replaces carried `42.50` and was searchable by it.
    search: [title, detail, item.amount && `${item.amount.value} ${item.amount.currency}`]
      .filter(Boolean)
      .join(' '),
    href: item.href,
    createdAt: item.createdAt,
  };
}
