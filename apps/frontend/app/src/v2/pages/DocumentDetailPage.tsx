import { formatCurrency, formatDate, formatDateTime } from '@scani/shared';
import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { PageLoader } from '@scani/ui/ui/loading';
import { Separator } from '@scani/ui/ui/separator';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ArrowLeft, ArrowRight, FileText, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

const REVIEW_STATE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  pending: 'outline',
  accepted: 'default',
  rejected: 'secondary',
};

type Extraction = RouterOutputs['documents']['get']['extractions'][number];

/**
 * Every extracted invoice found inside one uploaded document, with the
 * accept/reject actions `document_extractions.review_state` needs — the
 * surface `ReviewFeedService` has linked every extraction row to
 * (`/documents/:id`) since the review feed shipped.
 */
export function DocumentDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [confirmReparse, setConfirmReparse] = useState(false);

  const documentQuery = trpc.documents.get.useQuery({ documentId: id }, { enabled: Boolean(id) });

  const rejectMutation = trpc.documents.rejectExtraction.useMutation({
    onSuccess: () => {
      showSuccess('Extraction rejected');
      void utils.documents.get.invalidate({ documentId: id });
      void utils.documents.listExtractions.invalidate();
      void utils.review.listPending.invalidate();
    },
    onError: (error) => showError(error, 'Rejecting extraction'),
  });

  const reparseMutation = trpc.documents.reparse.useMutation({
    onSuccess: ({ jobId }) => {
      setConfirmReparse(false);
      void utils.documents.get.invalidate({ documentId: id });
      void utils.documents.listExtractions.invalidate();
      void utils.review.listPending.invalidate();
      navigate(V2_ROUTES.jobDetail(jobId));
    },
    onError: (error) => showError(error, 'Re-parsing document'),
  });

  if (!id) return null;
  if (documentQuery.isLoading) return <PageLoader />;
  if (documentQuery.error || !documentQuery.data) {
    return (
      <div className="max-w-2xl space-y-6">
        <BackLink />
        <p className="text-sm text-destructive">Document not found.</p>
      </div>
    );
  }

  const { document, extractions } = documentQuery.data;

  return (
    <div className="max-w-2xl space-y-6">
      <BackLink />

      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-2xl font-bold tracking-tight truncate">
            {document.originalFilename}
          </h2>
          {document.classification && <Badge variant="outline">{document.classification}</Badge>}
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Uploaded</dt>
            <dd className="text-right">{formatDateTime(document.createdAt)}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd className="text-right">{document.mimeType}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="text-right">{document.sourceKind}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Extracted invoices ({extractions.length})
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={reparseMutation.isPending}
            onClick={() => setConfirmReparse(true)}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Re-parse
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {extractions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No invoices were found in this document.
            </p>
          ) : (
            extractions.map((extraction) => (
              <ExtractionCard
                key={extraction.id}
                extraction={extraction}
                onApprove={() => navigate(V2_ROUTES.paymentCreateFromExtraction(extraction.id))}
                onReject={() => rejectMutation.mutate({ extractionId: extraction.id })}
                isPending={rejectMutation.isPending}
              />
            ))
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmReparse}
        onOpenChange={setConfirmReparse}
        title="Re-parse this document"
        description="Reads the file again with the current extractor and replaces every extraction that hasn't already been turned into a payment — those are kept. This costs an AI call."
        confirmLabel="Re-parse"
        isPending={reparseMutation.isPending}
        onConfirm={() => reparseMutation.mutate({ documentId: id })}
      />
    </div>
  );
}

function ExtractionCard({
  extraction,
  onApprove,
  onReject,
  isPending,
}: {
  extraction: Extraction;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{extraction.vendorNameRaw}</p>
          {extraction.invoiceNumber && (
            <p className="text-xs text-muted-foreground">Invoice #{extraction.invoiceNumber}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-semibold tabular-nums">
            {extraction.totalAmount
              ? formatCurrency(extraction.totalAmount, extraction.currencyCode ?? 'USD')
              : '—'}
          </span>
          <Badge variant={REVIEW_STATE_VARIANT[extraction.reviewState] ?? 'outline'}>
            {extraction.reviewState}
          </Badge>
        </div>
      </div>

      <Separator />

      <dl className="grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Issue date</dt>
        <dd className="text-right">{formatDate(extraction.issueDate)}</dd>
        <dt className="text-muted-foreground">Due date</dt>
        <dd className="text-right">{formatDate(extraction.dueDate)}</dd>
        <dt className="text-muted-foreground">Confidence</dt>
        <dd className="text-right">
          {extraction.confidence
            ? `${Math.round(Number(extraction.confidence) * 100)}%`
            : 'Unknown'}
        </dd>
      </dl>

      {extraction.reviewState === 'pending' && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={isPending} onClick={onApprove}>
              Approve
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
            <Button size="sm" variant="outline" disabled={isPending} onClick={onReject}>
              <X className="h-3.5 w-3.5 mr-1" />
              Reject
            </Button>
          </div>
          {/* One invoice can't prove a cadence, so approving opens the form
              rather than writing a payment the user never confirmed. */}
          <p className="text-[11px] text-muted-foreground">
            Opens a recurring payment prefilled from this invoice. Nothing is saved until you
            confirm it.
          </p>
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="h-7 gap-1 -ml-2">
      <Link to={V2_ROUTES.review}>
        <ArrowLeft className="h-3.5 w-3.5" />
        Review
      </Link>
    </Button>
  );
}
