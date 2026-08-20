import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { DocumentsList } from '../components/documents/DocumentsList';
import { type DocumentRow, documentPurposesMatching } from '../lib/documents';
import { V3_CAPTURE_ROUTES } from '../lib/routes';

const PAGE_SIZE = 100;

/**
 * Every file the user has ever uploaded.
 *
 * The infinite query lives here rather than behind v2's `useDocumentList`
 * because that hook collapses its result to a list and a boolean before either
 * interface sees it, and V3-16 made the error half of a read something a v3
 * surface is not allowed to drop — a 500 rendering as "No files yet" is the
 * exact failure `mergeQueries` exists to prevent. It also drops `downloadable`,
 * which is the difference between a row you can re-parse and one you cannot.
 *
 * **The search is the server's** (SC-244). It used to run over the rows already
 * fetched, so a search on page one answered "No files match" about a fraction
 * of the user's files, in the words this surface uses for someone who has
 * none. Filter, sort and group-by are still local and still see only what is
 * loaded — `V3DataView` says so on the count line and in the empty state,
 * which it can because `mergeQueries` tells it the set is a page.
 *
 * "Load more" belongs to `V3DataView` for the same reason: the component that
 * renders the empty screen is the one that has to offer the way out of it.
 */
export function FilesPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const filesQuery = trpc.documents.list.useInfiniteQuery(
    {
      limit: PAGE_SIZE,
      search: search || undefined,
      // The kind labels are this app's copy, so matching them is this app's
      // job — see `documentPurposesMatching`.
      matchPurposes: search ? documentPurposesMatching(search) : undefined,
    },
    {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      // Without it every keystroke empties the list back to the skeleton, and
      // the reader watches the thing they are reading disappear four times
      // while typing "hetzner".
      keepPreviousData: true,
    }
  );

  const documents = useMemo<DocumentRow[]>(
    () => (filesQuery.data?.pages ?? []).flatMap((page) => page.items),
    [filesQuery.data]
  );

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.documents.page.title')}
        action={
          <Button asChild>
            <Link to={V3_CAPTURE_ROUTES.invoiceUpload}>
              <Upload className="mr-1.5 size-4" aria-hidden="true" />
              {t('v3.documents.page.uploadInvoice')}
            </Link>
          </Button>
        }
      />

      <DocumentsList documents={documents} query={mergeQueries(filesQuery)} onSearch={setSearch} />
    </PageLayout>
  );
}
