import { formatBytes, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { CardInteractive } from '@scani/ui/ui/card';
import { FileText, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import { useDocumentList } from '../hooks/useDocuments';
import {
  compareDocuments,
  DOCUMENT_PURPOSE_FILTER_OPTIONS,
  type DocumentListItem,
  documentPurposeLabel,
  matchesDocumentSearch,
} from '../lib/documents';
import { V2_ROUTES } from '../lib/routes';

function FileCard({ item }: { item: DocumentListItem }) {
  return (
    <CardInteractive className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{item.originalFilename}</span>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
              {documentPurposeLabel(item.purpose)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatBytes(item.byteSize)} · {formatRelative(item.createdAt)}
            {item.extractionCount !== undefined &&
              ` · ${item.extractionCount} invoice${item.extractionCount === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>
    </CardInteractive>
  );
}

/**
 * Every file the user has ever uploaded — invoices, screenshots and imports
 * alike. Before this page the only route back to an uploaded file was a URL
 * you happened to keep: the review feed drops an invoice the moment it is
 * accepted or rejected, and screenshots and imports were never listed at all.
 */
export function FilesPage() {
  const navigate = useNavigate();
  const { documents, isLoading, error, hasMore, isLoadingMore, loadMore } = useDocumentList();

  const columns: ColumnDef<DocumentListItem>[] = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (item) => <span className="font-medium text-sm">{item.originalFilename}</span>,
    },
    {
      key: 'kind',
      label: 'Kind',
      sortable: true,
      render: (item) => (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          {documentPurposeLabel(item.purpose)}
        </Badge>
      ),
    },
    {
      key: 'invoices',
      label: 'Invoices',
      align: 'right',
      render: (item) => (
        <span className="tabular-nums text-sm text-muted-foreground">
          {item.extractionCount ?? '—'}
        </span>
      ),
    },
    {
      key: 'size',
      label: 'Size',
      align: 'right',
      sortable: true,
      render: (item) => (
        <span className="tabular-nums text-sm text-muted-foreground">
          {formatBytes(item.byteSize)}
        </span>
      ),
    },
    {
      key: 'uploaded',
      label: 'Uploaded',
      align: 'right',
      sortable: true,
      render: (item) => (
        <span className="text-sm text-muted-foreground">{formatRelative(item.createdAt)}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Files</h2>
          <p className="text-muted-foreground mt-1">
            {isLoading ? '' : `${documents.length}${hasMore ? '+' : ''} files`}
          </p>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link to={V2_ROUTES.documentUpload}>Upload invoice</Link>
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      <DataViewComponent
        config={{
          pageKey: 'files',
          data: documents,
          searchFn: matchesDocumentSearch,
          filterDefs: [
            {
              key: 'purpose',
              label: 'Kind',
              options: DOCUMENT_PURPOSE_FILTER_OPTIONS,
              fn: (item: DocumentListItem, value: string) => item.purpose === value,
            },
          ],
          sortDefs: [
            { key: 'uploaded', label: 'Uploaded' },
            { key: 'name', label: 'Name' },
            { key: 'kind', label: 'Kind' },
            { key: 'size', label: 'Size' },
          ],
          sortFn: compareDocuments,
          defaultSort: { field: 'uploaded', direction: 'desc' },
          defaultView: 'table',
        }}
        columns={columns}
        renderCard={(item: DocumentListItem) => <FileCard item={item} />}
        onRowClick={(item: DocumentListItem) => navigate(V2_ROUTES.documentDetail(item.id))}
        getId={(item: DocumentListItem) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">No files yet</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Invoices, screenshots and imports you upload are kept here.
            </p>
            <Button asChild size="sm" className="mt-3">
              <Link to={V2_ROUTES.documentUpload}>Upload invoice</Link>
            </Button>
          </div>
        }
      />

      {/* Search, filter and sort only ever see the rows already fetched, so
          this widens the page rather than replacing it. */}
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={isLoadingMore} onClick={() => loadMore()}>
            {isLoadingMore && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
