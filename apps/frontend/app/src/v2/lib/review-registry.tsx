import type { ReactNode } from 'react';
import { DocumentParseResult } from '../components/jobs/DocumentParseResult';
import { ExchangeImportResult } from '../components/jobs/ExchangeImportResult';
import { FileImportResult } from '../components/jobs/FileImportResult';
import { GenericJobResult } from '../components/jobs/GenericJobResult';
import { ManualHoldingsCreateResult } from '../components/jobs/ManualHoldingsCreateResult';
import { ScreenshotParseResult } from '../components/jobs/ScreenshotParseResult';
import { WalletImportResult } from '../components/jobs/WalletImportResult';

export interface ReviewRendererProps {
  result: unknown;
  jobId: string;
  actionTakenAt: Date | string | null;
}

export interface ReviewRenderer {
  kind: string;
  render(props: ReviewRendererProps): ReactNode;
}

/**
 * Renderers keyed by job name, covering every job kind that has a result
 * body on the job detail page — reviewable or not. This is independent of
 * `REVIEWABLE_JOB_NAMES` in @scani/shared: that list marks which job kinds
 * need user confirmation (drives the /review feed and the action-required
 * badge); this map only decides which component renders a job's result.
 * Adding a job-result renderer means adding an entry here — no existing
 * file changes, which is the whole point of replacing the switch.
 */
const RENDERERS: ReviewRenderer[] = [
  {
    kind: 'wallet-import',
    render: ({ result, jobId, actionTakenAt }) => (
      <WalletImportResult result={result} jobId={jobId} actionTakenAt={actionTakenAt} />
    ),
  },
  {
    kind: 'exchange-import',
    render: ({ result }) => <ExchangeImportResult result={result} />,
  },
  {
    kind: 'screenshot-parse',
    render: ({ result, jobId, actionTakenAt }) => (
      <ScreenshotParseResult result={result} jobId={jobId} actionTakenAt={actionTakenAt} />
    ),
  },
  {
    kind: 'file-import',
    render: ({ result, jobId }) => <FileImportResult result={result} jobId={jobId} />,
  },
  {
    kind: 'document-parse',
    render: ({ result }) => <DocumentParseResult result={result} />,
  },
  {
    kind: 'manual-holdings-create',
    render: ({ result }) => <ManualHoldingsCreateResult result={result} />,
  },
];

// `holding-price-update` and `user-data-delete` have no dedicated result
// body — their outcome is fully captured by the generic state/error chip —
// so they (and any future job kind we haven't built a renderer for yet)
// land here.
const FALLBACK: ReviewRenderer = {
  kind: '__fallback__',
  render: ({ result }) => <GenericJobResult result={result} />,
};

export function resolveReviewRenderer(kind: string): ReviewRenderer {
  return RENDERERS.find((r) => r.kind === kind) ?? FALLBACK;
}
