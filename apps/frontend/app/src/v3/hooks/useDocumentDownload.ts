import { showError } from '@scani/ui/ui/use-toast';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';

/**
 * Hands the browser a freshly signed URL for the stored file. Signed on the
 * click rather than on render because the URL expires — a link minted with the
 * list would already be stale by the time anyone used it.
 *
 * v3's copy of v2's `useDocumentDownload`, with its one toast context keyed
 * (SC-320). Only this half of `v2/hooks/useDocuments` was ever reached from
 * v3; `useDocumentList` belongs to v2's Files page and stays there.
 */
export function useDocumentDownload() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const download = useCallback(
    async (documentId: string) => {
      setPendingId(documentId);
      try {
        const client = utils.client.documents;
        const { url } = await client.getDownloadUrl.query({ documentId });
        const anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.click();
      } catch (error) {
        showError(error, t('v3.documents.toast.downloadingContext'));
      } finally {
        setPendingId(null);
      }
    },
    [utils, t]
  );

  return { download, pendingId };
}
