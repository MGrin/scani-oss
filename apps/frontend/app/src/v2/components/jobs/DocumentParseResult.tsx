import { Badge } from '@scani/ui/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { CheckCircle2, Copy, FileText } from 'lucide-react';

/**
 * Detail-page body for `document-parse` jobs. Read-only: accepting or
 * rejecting an extraction happens on `/documents/:id`
 * (`document_extractions.review_state`), not here — this view exists so
 * a `document-parse` job's own result isn't silently swallowed by
 * `GenericJobResult`.
 */
interface ExtractionSummary {
  id: string;
  vendorNameRaw: string;
  invoiceNumber: string | null;
  totalAmount: string | null;
  currencyCode: string | null;
}

interface DocumentParseSummary {
  documentId: string;
  deduped: boolean;
  invoiceCount: number;
  upstreamCostUsd: number;
  extractions: ExtractionSummary[];
}

function asSummary(v: unknown): DocumentParseSummary | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.documentId !== 'string') return null;
  if (typeof r.deduped !== 'boolean') return null;
  if (!Array.isArray(r.extractions)) return null;
  return r as unknown as DocumentParseSummary;
}

export function DocumentParseResult({ result }: { result: unknown }) {
  const summary = asSummary(result);

  if (!summary) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          Job completed without a recognizable result payload.
        </CardContent>
      </Card>
    );
  }

  if (summary.deduped) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <Copy className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm">Already processed</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            This file matches a document you submitted before, so it wasn't sent to AI again — no
            duplicate spend, no duplicate invoices.
          </p>
        </CardContent>
      </Card>
    );
  }

  const found = summary.invoiceCount > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        {found ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground" />
        )}
        <CardTitle className="text-sm">
          {found
            ? `Found ${summary.invoiceCount} invoice${summary.invoiceCount === 1 ? '' : 's'}`
            : 'No invoices found'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {summary.extractions.map((e) => (
          <div
            key={e.id}
            className="flex items-center justify-between gap-3 p-2 rounded-md border border-border"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{e.vendorNameRaw || 'Unknown vendor'}</p>
              {e.invoiceNumber && (
                <p className="text-[11px] text-muted-foreground">{e.invoiceNumber}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {e.totalAmount && (
                <span className="text-sm font-semibold tabular-nums">
                  {e.totalAmount} {e.currencyCode ?? ''}
                </span>
              )}
              <Badge variant="outline" className="text-[10px]">
                Pending review
              </Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
