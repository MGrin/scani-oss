import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { showError } from '@scani/ui/ui/use-toast';
import { AlertTriangle, ArrowRight, CheckCircle2, HelpCircle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { FiatCurrencySelect } from '@/v2/components/shared/FiatCurrencySelect';
import { useBaseCurrency } from '@/v2/hooks/useBaseCurrency';
import { V2_ROUTES } from '@/v2/lib/routes';

/**
 * Detail-page body for `file-import` jobs. The CSV/OFX/QIF flow ingests
 * holdings + transactions inline at parse time (no review step — the
 * data is structured), so this view is a post-import summary, not a
 * review screen. Per-holding row shows symbol, transaction count, and
 * closing balance from the statement.
 */
interface HoldingTouched {
  holdingId: string;
  tokenId: string;
  symbol: string;
  name: string;
  transactionCount: number;
  closingBalance: string | null;
}

interface NeedsCurrency {
  r2Key: string;
  fileType: string;
  transactionCount: number;
  transactionPreview: Array<{
    date: string;
    description: string;
    amount: number;
    balance: number | null;
  }>;
}

interface FileImportSummary {
  format: string;
  accountId: string;
  transactionCount: number;
  observationCount: number;
  holdingsCreated: string[];
  holdingsTouched: HoldingTouched[];
  warnings: string[];
  needsCurrency?: NeedsCurrency;
}

function asSummary(v: unknown): FileImportSummary | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.accountId !== 'string') return null;
  if (typeof r.transactionCount !== 'number') return null;
  if (!Array.isArray(r.holdingsTouched)) return null;
  return r as unknown as FileImportSummary;
}

export function FileImportResult({ result, jobId }: { result: unknown; jobId: string }) {
  const summary = asSummary(result);
  const { symbol: currency } = useBaseCurrency();

  if (!summary) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          Job completed without a recognizable result payload.
        </CardContent>
      </Card>
    );
  }

  // Currency-picker fallback: file had no Currency column and no
  // detectable per-row currency. Block ingestion until the user
  // picks one, then re-enqueue.
  if (summary.needsCurrency) {
    return (
      <CurrencyPickerCard
        accountId={summary.accountId}
        needsCurrency={summary.needsCurrency}
        warnings={summary.warnings}
        pickerJobId={jobId}
      />
    );
  }

  const hasWarnings = summary.warnings.length > 0;
  const importedZero = summary.transactionCount === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        {importedZero ? (
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        )}
        <CardTitle className="text-sm">
          {importedZero
            ? 'No transactions were imported'
            : `Imported ${summary.transactionCount} transaction${summary.transactionCount === 1 ? '' : 's'}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Format: <span className="font-medium text-foreground">{summary.format}</span> ·{' '}
          {summary.holdingsCreated.length > 0
            ? `${summary.holdingsCreated.length} new holding${summary.holdingsCreated.length === 1 ? '' : 's'} created`
            : 'reused existing holdings'}
          {summary.observationCount > 0
            ? ` · ${summary.observationCount} balance anchor${summary.observationCount === 1 ? '' : 's'} recorded`
            : ''}
        </p>

        {summary.holdingsTouched.length > 0 && (
          <div className="space-y-1">
            {summary.holdingsTouched.map((h) => {
              const isNew = summary.holdingsCreated.includes(h.holdingId);
              return (
                <div
                  key={h.holdingId}
                  className="flex items-center gap-3 w-full p-2 rounded-md border border-transparent hover:border-border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-sm">{h.symbol}</span>
                      {h.name && h.name !== h.symbol && (
                        <span className="text-muted-foreground text-xs truncate min-w-0">
                          {h.name}
                        </span>
                      )}
                      {isNew ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 border-green-500 text-green-500"
                        >
                          new
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 border-blue-500 text-blue-500"
                        >
                          updated
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                      {h.transactionCount} transaction{h.transactionCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  {h.closingBalance && (
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold tabular-nums whitespace-nowrap">
                        {formatCurrency(h.closingBalance, h.symbol)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">statement close</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hasWarnings && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 space-y-1 text-xs">
            <div className="font-medium">{summary.warnings.length} warning(s)</div>
            <ul className="list-disc pl-4 space-y-0.5 text-[11px] font-mono">
              {summary.warnings.slice(0, 5).map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warning strings have no stable id
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <Button asChild className="flex-1">
            <Link to={`${V2_ROUTES.holdings}?account=${encodeURIComponent(summary.accountId)}`}>
              View holdings
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="flex-1">
            <Link to={V2_ROUTES.fileImport}>Import another file</Link>
          </Button>
        </div>
        {/* Suppress an unused-variable warning when the dashboard's base
            currency isn't used (per-symbol formatting above uses the
            holding's own symbol, not the user's base). */}
        <span className="hidden">{currency}</span>
      </CardContent>
    </Card>
  );
}

// Renders when the file lacked a usable Currency column. User picks an
// ISO fiat code; we re-enqueue file-import against the same R2 key with
// `defaultCurrency` set, and the worker re-runs the parse end-to-end.
function CurrencyPickerCard({
  accountId,
  needsCurrency,
  warnings,
  pickerJobId,
}: {
  accountId: string;
  needsCurrency: NeedsCurrency;
  warnings: string[];
  pickerJobId: string;
}) {
  const navigate = useNavigate();
  const { symbol: baseSymbol } = useBaseCurrency();
  const [selectedSymbol, setSelectedSymbol] = useState(baseSymbol);

  // Stamp the picker job's actionTakenAt as soon as the user picks a
  // currency — without this, the original job stays "Needs review"
  // forever even after the follow-up import succeeds.
  const markActionTaken = trpc.jobs.markActionTaken.useMutation();

  const retryMutation = trpc.fileImport.parseAndEnrich.useMutation({
    onError: (err) => showError(err, 'Retrying with selected currency'),
    onSuccess: ({ jobId: newJobId }) => {
      markActionTaken.mutate({ jobId: pickerJobId });
      navigate(V2_ROUTES.jobDetail(newJobId));
    },
  });

  const onApply = () => {
    if (!selectedSymbol) return;
    retryMutation.mutate({
      r2Key: needsCurrency.r2Key,
      fileType: needsCurrency.fileType as 'csv' | 'ofx' | 'qif',
      accountId,
      requestId: crypto.randomUUID(),
      defaultCurrency: selectedSymbol,
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <HelpCircle className="h-4 w-4 text-amber-500" />
        <CardTitle className="text-sm">Currency required</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          We parsed{' '}
          <span className="font-medium text-foreground">
            {needsCurrency.transactionCount} transaction
            {needsCurrency.transactionCount === 1 ? '' : 's'}
          </span>{' '}
          but the file has no currency column and we couldn't auto-detect one. Pick the currency
          these transactions are denominated in to finish the import.
        </p>

        {needsCurrency.transactionPreview.length > 0 && (
          <div className="border rounded-md divide-y">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/30">
              Preview ({needsCurrency.transactionPreview.length} of {needsCurrency.transactionCount}
              )
            </div>
            {needsCurrency.transactionPreview.map((tx, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
                key={i}
                className="flex items-start gap-2 px-2 py-1.5 text-xs"
              >
                <span className="text-muted-foreground tabular-nums shrink-0 w-20">
                  {tx.date.slice(0, 10)}
                </span>
                <span className="flex-1 min-w-0 truncate">{tx.description || '—'}</span>
                <span
                  className={`tabular-nums shrink-0 ${
                    tx.amount < 0 ? 'text-destructive' : 'text-emerald-600'
                  }`}
                >
                  {tx.amount > 0 ? '+' : ''}
                  {tx.amount.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="text-xs text-muted-foreground sm:w-32 shrink-0">Statement currency</span>
          <FiatCurrencySelect
            value={selectedSymbol}
            onChange={setSelectedSymbol}
            valueField="symbol"
            variant="full"
            triggerClassName="flex-1"
          />
        </div>

        {warnings.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 space-y-1 text-xs">
            <div className="font-medium">{warnings.length} warning(s)</div>
            <ul className="list-disc pl-4 space-y-0.5 text-[11px] font-mono">
              {warnings.slice(0, 5).map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warning strings have no stable id
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <Button
          className="w-full"
          onClick={onApply}
          disabled={!selectedSymbol || retryMutation.isPending}
        >
          {retryMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Re-importing…
            </>
          ) : (
            <>
              Apply {selectedSymbol || '…'} and import
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
