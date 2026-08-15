import { formatBytes, formatDateTime } from '@scani/shared';
import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { useDocumentDownload } from '@/v2/hooks/useDocuments';
import { documentIcon, documentPurposeLabel } from '../../lib/documents';
import { jobDetailPath, V3_ROUTES } from '../../lib/routes';

/**
 * What the file *is*, plus the three things you can do to it — the top of
 * `/v3/documents/:documentId`, above whatever the extractor found in it.
 *
 * Same shape and the same reasoning as `JobDetailHeader`: the record carries
 * the destructive actions rather than the list row, because a mis-tap on a row
 * costs the most.
 *
 * Download and Re-parse are not rendered at all once the file is gone.
 * Retention shipped after ingestion did, and a failed parse deliberately keeps
 * its upload, so "the record exists but the object does not" is a real state
 * with a different set of things you can do about it — and the only outcome
 * either button has there is a PRECONDITION_FAILED. They used to be merely
 * disabled, above a sentence already explaining the file was gone; a greyed
 * button is still the page offering what it has just said it cannot do.
 *
 * `useDocumentDownload` is v2's, unchanged: it presigns on the click rather
 * than on render because the URL expires, which is a property of the endpoint
 * rather than of either interface.
 */

export interface DocumentDetailFile {
  id: string;
  purpose: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sourceKind: string;
  classification: string | null;
  createdAt: string;
  /** False once the stored object is gone. Both `documents.list` and
   *  `documents.get` carry it, from the same retention check, so the list row
   *  and this page cannot disagree about whether the file exists. */
  downloadable: boolean;
}

interface DocumentDetailHeaderProps {
  file: DocumentDetailFile;
  /** Invoices currently attached. Only invoices are read for them, so this is
   *  0 for every other purpose and the re-parse action stays hidden. */
  extractionCount: number;
}

export function DocumentDetailHeader({ file, extractionCount }: DocumentDetailHeaderProps) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { download, pendingId } = useDocumentDownload();
  const [confirmReparse, setConfirmReparse] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const settle = () => {
    void utils.documents.invalidate();
    void utils.review.listPending.invalidate();
  };

  const reparse = trpc.documents.reparse.useMutation({
    onSuccess: ({ jobId }) => {
      setConfirmReparse(false);
      // Straight to the job: a re-parse is an AI call that takes long enough
      // that staying here would show the same extractions until the user
      // reloaded, which reads as the button having done nothing.
      navigate(jobDetailPath(jobId));
    },
    onError: (error) => showError(error, 'Re-parsing the document'),
    onSettled: settle,
  });

  const remove = trpc.documents.delete.useMutation({
    onSuccess: () => {
      setConfirmDelete(false);
      showSuccess('File deleted — you can upload it again');
      // Navigate first: this page's own `documents.get` is the one query the
      // invalidation would refetch into a 404.
      navigate(V3_ROUTES.files, { replace: true });
    },
    onError: (error) => showError(error, 'Deleting the file'),
    onSettled: settle,
  });

  const Icon = documentIcon(file.mimeType);
  const isInvoice = file.purpose === 'invoice';
  const busy = reparse.isPending || remove.isPending;

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="truncate text-title">{file.originalFilename}</h1>
            <p className="truncate text-caption text-muted-foreground">
              {`${documentPurposeLabel(file.purpose)} · ${formatBytes(file.byteSize)} · ${file.mimeType}`}
            </p>
          </div>
        </div>
        {/* "Read as", because the line to the left of this already says what
            the file IS — `Invoice · 667 KB · image/jpeg` — from `purpose`,
            which is the shelf the upload route filed it on. `classification`
            is a different claim by a different author: what the extractor made
            of the bytes. Unlabelled, the two rendered as a header reading
            `Invoice` next to a chip reading `receipt`, which is one record
            contradicting itself rather than two facts that happen to differ
            (SC-69 3.4). They differing is often the interesting part. */}
        {file.classification ? (
          <Badge variant="outline" className="shrink-0">
            {`Read as ${file.classification}`}
          </Badge>
        ) : null}
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span>{`Uploaded ${formatDateTime(file.createdAt)}`}</span>
        <span>{`Arrived by ${file.sourceKind}`}</span>
        {/* Suppressed at zero: the body below already says "No invoices were
            found in this file" in a sentence, and a count of nothing directly
            above it is the same claim made twice and less clearly. */}
        {isInvoice && extractionCount > 0 ? (
          <span>{`${extractionCount} invoice${extractionCount === 1 ? '' : 's'} extracted`}</span>
        ) : null}
      </dl>

      {file.downloadable ? null : (
        <p className="rounded-md border border-border-strong bg-surface-hover p-2 text-caption">
          The stored copy of this file is gone, so it cannot be downloaded or read again. Deleting
          this record frees the file to be uploaded fresh.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {/* Absent, not disabled, once the object is gone. The sentence above
            has just said the stored copy no longer exists; a Download button
            under it — even greyed — is the page offering the one thing it has
            just said it cannot do, and `documents.get` used to assume the file
            was there so it was not even greyed (SC-69 3.1). Delete stays: it
            is the only action a record without a file still has. */}
        {file.downloadable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pendingId === file.id}
            onClick={() => void download(file.id)}
          >
            {pendingId === file.id ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="mr-2 size-4" aria-hidden="true" />
            )}
            Download
          </Button>
        ) : null}

        {isInvoice && file.downloadable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmReparse(true)}
          >
            <RefreshCw className="mr-2 size-4" aria-hidden="true" />
            {reparse.isPending ? 'Re-parsing…' : 'Re-parse'}
          </Button>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="mr-2 size-4" aria-hidden="true" />
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmReparse}
        onOpenChange={setConfirmReparse}
        title="Read this file again"
        description="Runs the current extractor over the file and replaces every invoice that has not already been turned into a payment — those are kept. This costs an AI call."
        confirmLabel="Re-parse"
        isPending={reparse.isPending}
        onConfirm={() => reparse.mutate({ documentId: file.id })}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this file"
        description="Removes the record, every invoice extracted from it, and the stored copy. Uploading the same file again will then read it fresh instead of being skipped as a duplicate. An invoice already turned into a payment blocks the delete — detach that payment first. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate({ documentId: file.id })}
      />
    </Block>
  );
}
