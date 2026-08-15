import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Loader2, Upload } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { DocumentsList } from '../components/documents/DocumentsList';
import type { DocumentRow } from '../lib/documents';
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
 * "Load more" sits below the list rather than inside it: search, filter and
 * sort only ever see the rows already fetched, so the button widens what the
 * surface can reason about rather than paging through it.
 */
export function FilesPage() {
  const filesQuery = trpc.documents.list.useInfiniteQuery(
    { limit: PAGE_SIZE },
    { getNextPageParam: (page) => page.nextCursor ?? undefined }
  );

  const documents = useMemo<DocumentRow[]>(
    () => (filesQuery.data?.pages ?? []).flatMap((page) => page.items),
    [filesQuery.data]
  );

  return (
    <PageLayout measure="wide">
      <PageHeader
        title="Files"
        action={
          <Button asChild>
            <Link to={V3_CAPTURE_ROUTES.invoiceUpload}>
              <Upload className="mr-1.5 size-4" aria-hidden="true" />
              Upload invoice
            </Link>
          </Button>
        }
      />

      <DocumentsList documents={documents} query={mergeQueries(filesQuery)} />

      {filesQuery.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={filesQuery.isFetchingNextPage}
            onClick={() => void filesQuery.fetchNextPage()}
          >
            {filesQuery.isFetchingNextPage ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Load more
          </Button>
        </div>
      ) : null}
    </PageLayout>
  );
}
