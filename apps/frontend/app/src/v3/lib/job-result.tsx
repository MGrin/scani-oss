import type { ReactNode } from 'react';
import { DocumentParseResult } from '../components/jobs/DocumentParseResult';
import { ExchangeImportResult } from '../components/jobs/ExchangeImportResult';
import { FileImportResult } from '../components/jobs/FileImportResult';
import { GenericJobResult } from '../components/jobs/GenericJobResult';
import { ManualHoldingsCreateResult } from '../components/jobs/ManualHoldingsCreateResult';
import { ScreenshotParseResult } from '../components/jobs/ScreenshotParseResult';
import { WalletImportResult } from '../components/jobs/WalletImportResult';

/**
 * Which component renders a job's result, keyed by job name.
 *
 * Covers every job kind that has a result body on the detail page, reviewable
 * or not — independent of `REVIEWABLE_JOB_NAMES` in `@scani/shared`, which
 * marks the kinds that need confirmation and drives the review feed. Adding a
 * renderer means adding an entry here and changing no existing file, which is
 * the whole reason this is a map rather than a switch.
 *
 * **This was v2's registry until SC-320 phase 3 slice 6.** v3 delegated to it
 * for as long as delegation was cheaper than a fork: a review renderer is the
 * *result* contract with the worker rather than presentation v3 gets to restyle
 * unilaterally, and copying seven components to change their padding would have
 * been the worst kind of duplication. What ended the delegation is that every
 * one of the seven turned out to differ in what it SAYS, not how it looks —
 * a count that is not the payload behind it, a figure rounded until it reads as
 * zero, a spam filter that hides rows the confirm still writes. Six slices, and
 * the last of them empties `src/v3`'s borrow list entirely.
 *
 * `holding-price-update` and `user-data-delete` have no dedicated body — their
 * outcome is fully carried by the state chip above — so they and any job kind
 * whose renderer has not been written land on the fallback.
 */

export interface ReviewRendererProps {
  result: unknown;
  jobId: string;
  actionTakenAt: Date | string | null;
  /** `imported` | `discarded` | null. A stamped job says *when* it was acted
   *  on; this says *what* happened, so a discarded parse is not rendered as an
   *  imported one (SC-138). */
  reviewOutcome: string | null;
}

export interface ReviewRenderer {
  kind: string;
  render(props: ReviewRendererProps): ReactNode;
}

const RENDERERS: Record<string, ReviewRenderer> = {
  'wallet-import': {
    kind: 'wallet-import',
    render: ({ result, jobId, actionTakenAt, reviewOutcome }) => (
      <WalletImportResult
        result={result}
        jobId={jobId}
        actionTakenAt={actionTakenAt}
        reviewOutcome={reviewOutcome}
      />
    ),
  },
  'exchange-import': {
    kind: 'exchange-import',
    render: ({ result }) => <ExchangeImportResult result={result} />,
  },
  'screenshot-parse': {
    kind: 'screenshot-parse',
    render: ({ result, jobId, actionTakenAt, reviewOutcome }) => (
      <ScreenshotParseResult
        result={result}
        jobId={jobId}
        actionTakenAt={actionTakenAt}
        reviewOutcome={reviewOutcome}
      />
    ),
  },
  'file-import': {
    kind: 'file-import',
    render: ({ result, jobId }) => <FileImportResult result={result} jobId={jobId} />,
  },
  /**
   * v2's version of this entry ends at a link to `/documents/<id>`, because in
   * v2 the decision lives on that page. In v3 the invoice upload lands *here* —
   * `InvoiceUploadPage` navigates to the job — and the next action is the
   * payment form, not a second navigation.
   */
  'document-parse': {
    kind: 'document-parse',
    render: ({ result }) => <DocumentParseResult result={result} />,
  },
  'manual-holdings-create': {
    kind: 'manual-holdings-create',
    render: ({ result }) => <ManualHoldingsCreateResult result={result} />,
  },
};

const FALLBACK: ReviewRenderer = {
  kind: '__fallback__',
  render: ({ result }) => <GenericJobResult result={result} />,
};

export function resolveV3ReviewRenderer(kind: string): ReviewRenderer {
  return RENDERERS[kind] ?? FALLBACK;
}
