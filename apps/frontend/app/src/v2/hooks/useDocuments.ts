import { showError } from '@scani/ui/ui/use-toast';
import { useCallback, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { DocumentListItem } from '../lib/documents';

/**
 * `documents.list` and `documents.downloadUrl` are declared here rather than
 * read off `RouterOutputs`, because the API side of the Files page ships on
 * its own branch — until it merges, the generated `AppRouter` stops at
 * `documents.get` and neither procedure exists at the type level.
 *
 * When it lands, delete `PendingDocumentsApi` / `PendingDocumentsClient` and
 * the two casts below; every call site here already matches the agreed
 * contract, so nothing else moves.
 */
interface DocumentListPage {
  items: DocumentListItem[];
  nextCursor?: string | null;
}

interface PendingDocumentsApi {
  list: {
    useInfiniteQuery(
      input: { limit: number },
      opts: { getNextPageParam: (page: DocumentListPage) => string | undefined }
    ): {
      data?: { pages: DocumentListPage[] };
      isLoading: boolean;
      error: { message: string } | null;
      hasNextPage?: boolean;
      isFetchingNextPage: boolean;
      fetchNextPage: () => void;
    };
  };
}

interface PendingDocumentsClient {
  downloadUrl: {
    query(input: { documentId: string }): Promise<{ url: string }>;
  };
}

const documentsApi = trpc.documents as unknown as PendingDocumentsApi;

const PAGE_SIZE = 100;

export interface DocumentListResult {
  documents: DocumentListItem[];
  isLoading: boolean;
  error: { message: string } | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

/**
 * Every file the caller has uploaded, newest first. Paginated on the wire and
 * flattened here: `DataView` searches, filters and sorts the rows it has been
 * given, so "Load more" widens what the page can see rather than replacing it.
 */
export function useDocumentList(): DocumentListResult {
  const query = documentsApi.list.useInfiniteQuery(
    { limit: PAGE_SIZE },
    { getNextPageParam: (page) => page.nextCursor ?? undefined }
  );

  const documents = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data]
  );

  return {
    documents,
    isLoading: query.isLoading,
    error: query.error,
    hasMore: Boolean(query.hasNextPage),
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
  };
}

/**
 * Hands the browser a freshly signed URL for the stored file. Signed on the
 * click rather than on render because the URL expires — a link minted with the
 * list would already be stale by the time anyone used it.
 */
export function useDocumentDownload() {
  const utils = trpc.useUtils();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const download = useCallback(
    async (documentId: string) => {
      setPendingId(documentId);
      try {
        const client = utils.client.documents as unknown as PendingDocumentsClient;
        const { url } = await client.downloadUrl.query({ documentId });
        const anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.click();
      } catch (error) {
        showError(error, 'Downloading file');
      } finally {
        setPendingId(null);
      }
    },
    [utils]
  );

  return { download, pendingId };
}
