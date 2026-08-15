import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { ArrowLeft, FileText } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { DocumentDetailHeader } from '../components/documents/DocumentDetailHeader';
import { ExtractionRecord } from '../components/documents/ExtractionRecord';
import { V3_PAYMENT_ROUTES, V3_ROUTES } from '../lib/routes';

/**
 * One uploaded file, and whatever the extractor found in it.
 *
 * A page rather than a peek — `documentDetailPath` carries the reasoning. The
 * short version: the body is a repeating record list whose primary action
 * navigates away, and a sheet you leave by its own main button is a sheet you
 * cannot get back to.
 *
 * `documents.get` now carries `downloadable`, as the list always did. It used
 * to be assumed true here on the grounds that the download endpoint is the
 * authority — which it is, but the reader is not an endpoint: the list said
 * "file removed" and this page offered a full-weight Download beside it (SC-69
 * 3.1). Both surfaces read the same retention check now, so they cannot
 * disagree about whether the file exists.
 */
export function DocumentDetailPage() {
  const { documentId = '' } = useParams<{ documentId: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const documentQuery = trpc.documents.get.useQuery(
    { documentId },
    { enabled: Boolean(documentId) }
  );

  const reject = trpc.documents.rejectExtraction.useMutation({
    onSuccess: () => showSuccess('Invoice rejected'),
    onError: (error) => showError(error, 'Rejecting the invoice'),
    onSettled: () => {
      void utils.documents.invalidate();
      void utils.review.listPending.invalidate();
    },
  });

  if (documentQuery.isLoading) {
    return (
      <PageLayout>
        <BackLink />
        <Skeleton className="h-40 w-full" aria-hidden="true" />
      </PageLayout>
    );
  }

  if (documentQuery.isError || !documentQuery.data) {
    return (
      <PageLayout>
        <BackLink />
        <QueryError
          error={documentQuery.error}
          subject="this file"
          onRetry={() => void documentQuery.refetch()}
        />
      </PageLayout>
    );
  }

  const { document, extractions } = documentQuery.data;

  return (
    <PageLayout>
      <BackLink />

      <DocumentDetailHeader
        file={{
          id: document.id,
          purpose: document.purpose,
          originalFilename: document.originalFilename,
          mimeType: document.mimeType,
          byteSize: document.byteSize,
          sourceKind: document.sourceKind,
          classification: document.classification,
          createdAt: document.createdAt,
          downloadable: document.downloadable,
        }}
        extractionCount={extractions.length}
      />

      {document.purpose === 'invoice' && extractions.length === 0 ? (
        // Not `DataViewEmpty`: this is not a list that happens to be empty, it
        // is a result, and the action that belongs with it is Re-parse — which
        // is already in the header directly above.
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface-1 p-8 text-center">
          <FileText className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-label">No invoices were found in this file</p>
          <p className="text-body text-muted-foreground">
            The file was read and nothing invoice-shaped came out of it. Re-parse runs the current
            extractor over it again.
          </p>
        </div>
      ) : null}

      {extractions.map((extraction) => (
        <ExtractionRecord
          key={extraction.id}
          extraction={extraction}
          isRejecting={reject.isPending}
          onApprove={() => navigate(V3_PAYMENT_ROUTES.fromExtraction(extraction.id))}
          onReject={() => reject.mutate({ extractionId: extraction.id })}
        />
      ))}
    </PageLayout>
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2 self-start">
      <Link to={V3_ROUTES.files}>
        <ArrowLeft className="mr-2 size-4" aria-hidden="true" />
        All files
      </Link>
    </Button>
  );
}
