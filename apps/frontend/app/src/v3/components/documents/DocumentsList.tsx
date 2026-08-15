import { formatBytes, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportCount, exportDateTime, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { FileText } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  compareDocuments,
  type DocumentRow,
  documentIcon,
  documentPurposeLabel,
  documentPurposeOptions,
  extractionOutcome,
  extractionOutcomeLabel,
  extractionOutcomeOptions,
  extractionSummary,
  matchesDocumentSearch,
} from '../../lib/documents';
import { documentDetailPath, V3_CAPTURE_ROUTES } from '../../lib/routes';
import { DocumentTotalsSummary } from './DocumentTotalsSummary';

/**
 * Every file the user has ever uploaded — invoices, screenshots and imports
 * alike, as one list.
 *
 * The two dimensions are **kind** (why the file is here) and **outcome** (what
 * the extractor made of it), and both are offered as a filter and one as a
 * group-by. v2 shows the raw extraction count with an em dash for everything
 * else, which collapses the two outcomes that matter into the same cell: a PDF
 * the extractor found nothing in reads identically to a screenshot that was
 * never sent to it. The first wants Re-parse; the second is working correctly.
 *
 * Rows navigate rather than peek — see `documentDetailPath` for why.
 */

interface DocumentsListProps {
  documents: DocumentRow[];
  query: V3QueryState;
}

export function DocumentsList({ documents, query }: DocumentsListProps) {
  const navigate = useNavigate();

  const config: V3DataViewConfig<DocumentRow> = {
    pageKey: 'files',
    data: documents,
    noun: 'files',
    searchPlaceholder: 'Search files',
    searchFn: matchesDocumentSearch,
    filterDefs: [
      {
        key: 'purpose',
        label: 'Kind',
        options: documentPurposeOptions(documents),
        fn: (document: DocumentRow, value) => document.purpose === value,
      },
      {
        key: 'outcome',
        label: 'Invoices',
        options: extractionOutcomeOptions(documents),
        fn: (document: DocumentRow, value) => extractionOutcome(document) === value,
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
    groupByDefs: [
      {
        key: 'kind',
        label: 'Kind',
        fn: (document: DocumentRow) => documentPurposeLabel(document.purpose),
      },
      {
        key: 'outcome',
        label: 'Invoices',
        fn: (document: DocumentRow) => extractionOutcomeLabel(extractionOutcome(document)),
      },
    ],
    summary: (shown) => <DocumentTotalsSummary documents={shown} />,
    renderRow: (document) => {
      const Icon = documentIcon(document.mimeType);
      const outcome = extractionOutcome(document);
      return {
        leading: <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />,
        label: document.originalFilename,
        sublabel: `${documentPurposeLabel(document.purpose)} · ${formatBytes(document.byteSize)}${
          document.downloadable ? '' : ' · file removed'
        }`,
        // The outcome is muted unless it is the one that wants an action:
        // "Nothing found" is the only value on this screen a reader can do
        // something about, so it is the only one that carries weight.
        value: (
          <span className={outcome === 'nothing-found' ? undefined : 'text-muted-foreground'}>
            {extractionSummary(document)}
          </span>
        ),
        delta: <span className="text-muted-foreground">{formatRelative(document.createdAt)}</span>,
        ariaLabel: `${document.originalFilename}, ${documentPurposeLabel(document.purpose)}, ${extractionSummary(document)}`,
      };
    },
    columns: [
      {
        key: 'name',
        header: 'Name',
        sortable: true,
        width: 'w-[36%]',
        render: (document) => {
          const Icon = documentIcon(document.mimeType);
          return (
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate text-label">{document.originalFilename}</span>
            </span>
          );
        },
      },
      {
        key: 'kind',
        header: 'Kind',
        sortable: true,
        width: 'w-32',
        render: (document) => (
          <Badge variant="outline">{documentPurposeLabel(document.purpose)}</Badge>
        ),
        exportValue: (document) => exportText(documentPurposeLabel(document.purpose)),
      },
      {
        key: 'outcome',
        header: 'Invoices',
        width: 'w-36',
        render: (document) => (
          <span className="text-muted-foreground">{extractionSummary(document)}</span>
        ),
      },
      {
        key: 'size',
        header: 'Size',
        sortable: true,
        numeric: true,
        width: 'w-28',
        render: (document) => (
          <span className="text-muted-foreground">{formatBytes(document.byteSize)}</span>
        ),
        // Bytes, not "1.2 MB": a size column a reader can sort and sum is worth
        // more in a spreadsheet than one already rounded for a table cell.
        exportValue: (document) => exportCount(document.byteSize),
      },
      {
        key: 'uploaded',
        header: 'Uploaded',
        sortable: true,
        numeric: true,
        width: 'w-36',
        render: (document) => (
          <span className="text-muted-foreground">{formatRelative(document.createdAt)}</span>
        ),
        // The instant, not "3 days ago": a relative date is a fact about when
        // the file was made, and it stops being true the moment it is saved.
        exportValue: (document) => exportDateTime(document.createdAt),
      },
    ],
    empty: {
      icon: FileText,
      title: 'No files yet',
      description:
        'Invoices, screenshots and statement files you upload are kept here, with whatever was read out of them.',
      action: (
        <Button asChild>
          <Link to={V3_CAPTURE_ROUTES.invoiceUpload}>Upload an invoice</Link>
        </Button>
      ),
    },
    onRowClick: (document) => navigate(documentDetailPath(document.id)),
    rowHref: (document) => documentDetailPath(document.id),
  };

  return <V3DataView config={config} getId={(document) => document.id} query={query} />;
}
