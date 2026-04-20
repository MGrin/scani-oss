import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { V2_ROUTES } from '../../lib/routes';
import { type ReviewHoldingInput, ReviewHoldingsCard } from './ReviewHoldingsCard';

/**
 * Detail-page body for `file-import` jobs (CSV / OFX / QIF statements).
 *
 * Same shape as `ScreenshotParseResult` in spirit — the worker extracts
 * holdings and enriches them (fuzzy-matches existing tokens, carries over
 * previous balances); the user still needs to confirm them in the review
 * step before anything lands in their portfolio. This view shows what
 * was extracted and links back to the upload page to finish.
 */
interface FileHolding {
  symbol?: string;
  name?: string;
  balance?: string;
  confidence?: number;
  existingBalance?: string | null;
  // tokenId / holdingId are what the worker's EnrichHoldingsUseCase
  // resolves. Without them the review card sees every row as
  // "unmatched" and the Import button stays at 0.
  tokenId?: string | null;
  holdingId?: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function FileImportResult({
  result,
  jobId,
  actionTakenAt,
}: {
  result: unknown;
  jobId?: string;
  actionTakenAt?: Date | string | null;
}) {
  const r = asRecord(result);
  const holdings = (Array.isArray(r.holdings) ? r.holdings : []) as FileHolding[];
  const errors = (Array.isArray(r.errors) ? r.errors : []) as unknown[];
  const accountName = typeof r.accountName === 'string' ? r.accountName : null;
  const accountId = typeof r.accountId === 'string' && r.accountId.length > 0 ? r.accountId : null;
  const hasErrors = errors.length > 0;

  // Shape the raw worker holdings into the review-card contract.
  const reviewHoldings: ReviewHoldingInput[] = holdings.map((h) => ({
    symbol: h.symbol ?? '',
    name: h.name ?? null,
    balance: String(h.balance ?? '0'),
    confidence: typeof h.confidence === 'number' ? h.confidence : undefined,
    existingBalance: h.existingBalance ?? null,
    tokenId: h.tokenId ?? null,
    holdingId: h.holdingId ?? null,
  }));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          {hasErrors && holdings.length === 0 ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : hasErrors ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          )}
          <CardTitle className="text-sm">Statement parsed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Extracted <span className="font-medium text-foreground">{holdings.length}</span> holding
            {holdings.length === 1 ? '' : 's'}
            {accountName ? (
              <>
                {' '}
                for <span className="font-medium text-foreground">{accountName}</span>
              </>
            ) : null}
            .
          </p>

          {holdings.length > 0 && !accountId && (
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1.5">
              <p className="text-xs font-medium">Finish on the upload page</p>
              <p className="text-xs text-muted-foreground">
                This import didn't record the target account. Open the upload page to pick one and
                confirm the extracted rows.
              </p>
              <Button asChild size="sm" className="mt-1">
                <Link to={V2_ROUTES.fileImport}>
                  <FileText className="h-3.5 w-3.5 mr-1" />
                  Review on upload page
                </Link>
              </Button>
            </div>
          )}

          {hasErrors && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 space-y-1">
              <div className="text-xs font-medium">{errors.length} parse error(s)</div>
              <ul className="list-disc pl-4 space-y-0.5 text-xs font-mono">
                {errors.slice(0, 10).map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: error strings aren't identified
                  <li key={i}>{typeof e === 'string' ? e : JSON.stringify(e)}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {accountId && reviewHoldings.length > 0 && (
        <ReviewHoldingsCard
          accountId={accountId}
          holdings={reviewHoldings}
          fileSource="statement"
          jobId={jobId}
          actionTakenAt={actionTakenAt}
        />
      )}
    </div>
  );
}
