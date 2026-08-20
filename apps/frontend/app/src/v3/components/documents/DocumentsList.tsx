import { formatBytes } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportCount, exportDateTime, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
} from '../../lib/documents';
import { formatRelative } from '../../lib/relative-time';
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
  /**
   * Required, not optional (SC-244). `documents` is one page of the user's
   * files, so a list that searched what it held would report "No files match"
   * about a fraction of them in the words it uses for an account with none. A
   * caller that cannot search on the server has no business rendering this
   * search box, so the compiler asks rather than the reader finding out.
   */
  onSearch: (term: string) => void;
}

export function DocumentsList({ documents, query, onSearch }: DocumentsListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const config: V3DataViewConfig<DocumentRow> = {
    pageKey: 'files',
    data: documents,
    nounKey: 'ui.dataView.noun.files',
    searchPlaceholderKey: 'ui.dataView.files.config.searchFiles',
    onSearch,
    filterDefs: [
      {
        key: 'purpose',
        labelKey: 'ui.dataView.files.filter.kind',
        options: documentPurposeOptions(documents),
        fn: (document: DocumentRow, value) => document.purpose === value,
      },
      {
        key: 'outcome',
        labelKey: 'ui.dataView.files.filter.invoices',
        options: extractionOutcomeOptions(t, documents),
        fn: (document: DocumentRow, value) => extractionOutcome(document) === value,
      },
    ],
    sortDefs: [
      { key: 'uploaded', labelKey: 'ui.dataView.files.sort.uploaded' },
      { key: 'name', labelKey: 'ui.dataView.files.sort.name' },
      { key: 'kind', labelKey: 'ui.dataView.files.sort.kind' },
      { key: 'size', labelKey: 'ui.dataView.files.sort.size' },
    ],
    sortFn: compareDocuments,
    defaultSort: { field: 'uploaded', direction: 'desc' },
    groupByDefs: [
      {
        key: 'kind',
        labelKey: 'ui.dataView.files.group.kind',
        fn: (document: DocumentRow) => documentPurposeLabel(document.purpose),
      },
      {
        key: 'outcome',
        labelKey: 'ui.dataView.files.group.invoices',
        fn: (document: DocumentRow) => extractionOutcomeLabel(t, extractionOutcome(document)),
      },
    ],
    summary: (shown) => <DocumentTotalsSummary documents={shown} />,
    renderRow: (document) => {
      const Icon = documentIcon(document.mimeType);
      const outcome = extractionOutcome(document);
      return {
        leading: <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />,
        label: document.originalFilename,
        // Three facts joined by the separator this list uses everywhere, not a
        // sentence with a clause appended (SC-235). `"· file removed"` carried
        // the middot that pinned it to the right of the byte count.
        sublabel: [
          documentPurposeLabel(document.purpose),
          formatBytes(document.byteSize),
          document.downloadable ? null : t('v3.documents.fileRemoved'),
        ]
          .filter(Boolean)
          .join(' · '),
        // The outcome is muted unless it is the one that wants an action:
        // "Nothing found" is the only value on this screen a reader can do
        // something about, so it is the only one that carries weight.
        value: (
          <span className={outcome === 'nothing-found' ? undefined : 'text-muted-foreground'}>
            {extractionSummary(t, document)}
          </span>
        ),
        delta: (
          <span className="text-muted-foreground">{formatRelative(t, document.createdAt)}</span>
        ),
        ariaLabel: `${document.originalFilename}, ${documentPurposeLabel(document.purpose)}, ${extractionSummary(t, document)}`,
      };
    },
    columns: [
      {
        key: 'name',
        headerKey: 'ui.dataView.files.col.name',
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
        headerKey: 'ui.dataView.files.col.kind',
        sortable: true,
        width: 'w-32',
        render: (document) => (
          <Badge variant="outline">{documentPurposeLabel(document.purpose)}</Badge>
        ),
        exportValue: (document) => exportText(documentPurposeLabel(document.purpose)),
      },
      {
        key: 'outcome',
        headerKey: 'ui.dataView.files.col.invoices',
        width: 'w-36',
        render: (document) => (
          <span className="text-muted-foreground">{extractionSummary(t, document)}</span>
        ),
      },
      {
        key: 'size',
        headerKey: 'ui.dataView.files.col.size',
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
        headerKey: 'ui.dataView.files.col.uploaded',
        sortable: true,
        numeric: true,
        width: 'w-36',
        render: (document) => (
          <span className="text-muted-foreground">{formatRelative(t, document.createdAt)}</span>
        ),
        // The instant, not "3 days ago": a relative date is a fact about when
        // the file was made, and it stops being true the moment it is saved.
        exportValue: (document) => exportDateTime(document.createdAt),
      },
    ],
    empty: {
      icon: FileText,
      titleKey: 'ui.dataView.files.empty.noFilesYet',
      descriptionKey: 'ui.dataView.files.empty.invoicesScreenshotsAndStatementFilesYou',
      action: (
        <Button asChild>
          <Link to={V3_CAPTURE_ROUTES.invoiceUpload}>{t('v3.documents.uploadInvoice')}</Link>
        </Button>
      ),
    },
    onRowClick: (document) => navigate(documentDetailPath(document.id)),
    rowHref: (document) => documentDetailPath(document.id),
  };

  return <V3DataView config={config} getId={(document) => document.id} query={query} />;
}
