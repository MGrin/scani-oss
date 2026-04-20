import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { V2_ROUTES } from '../../lib/routes';
import { type ReviewHoldingInput, ReviewHoldingsCard } from './ReviewHoldingsCard';

/**
 * Detail-page body for `screenshot-parse` jobs.
 *
 * The parser produces `ExtractedHolding[]` per file — those need to go
 * through the FileImportPage review step to become real holdings.
 * Historically this was only reachable if the user stayed on the upload
 * page for the entire job; leaving the page meant the extracted data
 * was "stranded" on the job record with no way to act on it.
 *
 * This view renders a per-file summary plus a CTA back to the upload
 * page. Review-in-place is a follow-up: the review step owns token
 * resolution + batch-create and isn't trivial to relocate.
 */
interface ScreenshotFileResult {
  r2Key: string;
  success: boolean;
  error?: string;
  data?: {
    overallConfidence?: number;
    holdings?: Array<{
      symbol?: string;
      balance?: string;
      name?: string;
      // tokenId/holdingId are set by EnrichHoldingsUseCase during parse.
      // Without them in the review payload every row shows as
      // "unmatched" and the Import button stays disabled.
      tokenId?: string | null;
      holdingId?: string | null;
      existingBalance?: string | null;
      confidence?: number;
    }>;
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function ScreenshotParseResult({
  result,
  jobId,
  actionTakenAt,
}: {
  result: unknown;
  jobId?: string;
  actionTakenAt?: Date | string | null;
}) {
  const r = asRecord(result);
  const results = (Array.isArray(r.results) ? r.results : []) as ScreenshotFileResult[];
  const summary = asRecord(r.summary);
  const totalFiles = Number(summary.totalFiles ?? results.length ?? 0);
  const successCount = Number(summary.successCount ?? 0);
  const failureCount = Number(summary.failureCount ?? 0);
  const accountId = typeof r.accountId === 'string' && r.accountId.length > 0 ? r.accountId : null;

  const successes = results.filter((it) => it.success);
  const failures = results.filter((it) => !it.success);
  const extractedCount = successes.reduce((n, s) => n + (s.data?.holdings?.length ?? 0), 0);

  // Decide what to call the file(s). PDFs shouldn't be labelled
  // "Screenshot" — they go through the same AI pipeline but UX-wise
  // they're statements. Infer from the r2Key extension.
  const allPdf =
    results.length > 0 && results.every((it) => (it.r2Key ?? '').toLowerCase().endsWith('.pdf'));
  const fileNoun = allPdf ? 'PDF' : 'screenshot';
  const fileNounPlural = allPdf ? 'PDFs' : 'screenshots';
  const titleWord = allPdf ? 'PDF' : 'Screenshot';
  const filesLabel = totalFiles === 1 ? fileNoun : fileNounPlural;

  // Aggregate extracted holdings across all successful files for the
  // review card. Most screenshot-parse runs have a single file; the
  // many-file case (batch upload) still makes sense as a single review.
  const aggregatedHoldings: ReviewHoldingInput[] = successes.flatMap((s) => {
    const items = s.data?.holdings ?? [];
    return items.map((h) => ({
      symbol: h.symbol ?? '',
      name: h.name ?? null,
      balance: String(h.balance ?? '0'),
      confidence: typeof h.confidence === 'number' ? h.confidence : undefined,
      tokenId: h.tokenId ?? null,
      holdingId: h.holdingId ?? null,
      existingBalance: h.existingBalance ?? null,
    }));
  });
  const overallConfidence =
    successes.length === 1 && typeof successes[0]?.data?.overallConfidence === 'number'
      ? successes[0].data.overallConfidence
      : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          {failureCount > 0 && successCount === 0 ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : failureCount > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          )}
          <CardTitle className="text-sm">{titleWord} parse summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Parsed {totalFiles} {filesLabel} — {successCount} succeeded, {failureCount} failed.
            Extracted{' '}
            <span className="font-medium text-foreground">
              {extractedCount} holding{extractedCount === 1 ? '' : 's'}
            </span>{' '}
            in total.
          </p>

          {successCount > 0 && !accountId && (
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1.5">
              <p className="text-xs font-medium">Finish on the upload page</p>
              <p className="text-xs text-muted-foreground">
                This import didn't lock in an account at submit time (new-account flow). Open the
                upload page to pick the account and confirm the extracted holdings.
              </p>
              <Button asChild size="sm" className="mt-1">
                <Link to={V2_ROUTES.fileImport}>
                  <FileText className="h-3.5 w-3.5 mr-1" />
                  Review on upload page
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {failures.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              {failures.length} {failures.length === 1 ? fileNoun : fileNounPlural} couldn't be
              parsed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Deliberately hide provider-specific errors (OpenAI 400
                status, etc.) from the user — they're implementation
                detail, not actionable. We just tell the user the file
                didn't parse and suggest a retry. The full error is in
                the worker logs + the raw job payload for debugging. */}
            <p className="text-xs text-muted-foreground">
              We couldn't extract holdings from{' '}
              {failures.length === 1 ? 'this file' : 'these files'}.{' '}
              {allPdf
                ? 'This can happen with scanned, image-only, or encrypted PDFs, or when the document layout is very unusual.'
                : 'This can happen with low-resolution or very busy screenshots.'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Try again with a clearer {fileNoun}, crop the relevant section, or upload as a CSV/OFX
              export if your provider offers one.
            </p>
          </CardContent>
        </Card>
      )}

      {accountId && aggregatedHoldings.length > 0 && (
        <ReviewHoldingsCard
          accountId={accountId}
          holdings={aggregatedHoldings}
          // PDFs render a "Statement" pill; images render "Screenshot".
          // Same extractor code path, different user-facing label.
          fileSource={allPdf ? 'statement' : 'screenshot'}
          overallConfidence={overallConfidence}
          jobId={jobId}
          actionTakenAt={actionTakenAt}
        />
      )}
    </div>
  );
}
