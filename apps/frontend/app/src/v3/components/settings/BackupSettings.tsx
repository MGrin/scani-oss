import { formatBytes, formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { Archive, ArchiveRestore, Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useJobStatus } from '@/v3/hooks/useJobStatus';
import { uploadToR2 } from '@/v3/lib/r2-upload';

/**
 * A backup (SC-1649): every row the account owns, in one file the worker
 * writes. Unlike the export above it carries the balance readings and decisions
 * the figures are computed from, which is what makes it restorable. The copy
 * says what is NOT in it before the person relies on it: uploaded documents are
 * not included until SC-1662, so nothing here says "full" (operator, bus #23688).
 *
 * Restoring is offered only to an empty account (ruling Q1): the server checks
 * that again, inside the job's own transaction, before it writes anything.
 */
export function BackupSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const latest = trpc.backups.latest.useQuery();
  const [jobId, setJobId] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const create = trpc.backups.create.useMutation({
    onSuccess: ({ jobId: enqueued }) => setJobId(enqueued),
    onError: (error) => showError(error, t('v3.settings.pending.makingBackup')),
  });
  const status = useJobStatus(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (status.state === 'completed') {
      showSuccess(t('v3.settings.backup.ready'));
      setJobId(null);
      void utils.backups.latest.invalidate();
    } else if (status.finalFailure) {
      showError(
        status.userFacingError ?? t('v3.settings.backup.failed'),
        t('v3.settings.pending.makingBackup')
      );
      setJobId(null);
    }
  }, [jobId, status.state, status.finalFailure, status.userFacingError, utils, t]);

  const download = async (backupId: string) => {
    setFetching(true);
    try {
      const { url } = await utils.client.backups.downloadUrl.query({ backupId });
      window.location.assign(url);
    } catch (error) {
      showError(error, t('v3.settings.pending.downloadingBackup'));
    } finally {
      setFetching(false);
    }
  };

  const restorable = trpc.backups.restorable.useQuery();
  const getUploadUrl = trpc.storage.getUploadUrl.useMutation();
  const restore = trpc.backups.restore.useMutation();
  const picker = useRef<HTMLInputElement>(null);
  const [restoreJobId, setRestoreJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const restoreStatus = useJobStatus(restoreJobId);

  useEffect(() => {
    if (!restoreJobId) return;
    if (restoreStatus.state === 'completed') {
      const result = (restoreStatus.result ?? {}) as { rows?: number; unmatchedTokens?: number };
      const unmatched = result.unmatchedTokens ?? 0;
      showSuccess(
        [
          t('v3.settings.backup.restored', { rows: result.rows ?? 0 }),
          unmatched > 0 ? t('v3.settings.backup.restoredUnmatched', { tokens: unmatched }) : null,
        ]
          .filter(Boolean)
          .join(' ')
      );
      setRestoreJobId(null);
      void utils.invalidate();
    } else if (restoreStatus.finalFailure) {
      showError(
        restoreStatus.userFacingError ?? t('v3.settings.backup.restoreFailed'),
        t('v3.settings.pending.restoringBackup')
      );
      setRestoreJobId(null);
    }
  }, [
    restoreJobId,
    restoreStatus.state,
    restoreStatus.result,
    restoreStatus.finalFailure,
    restoreStatus.userFacingError,
    utils,
    t,
  ]);

  const startRestore = async (file: File) => {
    setUploading(true);
    try {
      const upload = await getUploadUrl.mutateAsync({
        purpose: 'backup',
        contentType: file.type || 'application/gzip',
        filename: file.name,
        sizeBytes: file.size,
      });
      await uploadToR2(file, { uploadUrl: upload.uploadUrl, requiredHeaders: upload.headers });
      const { jobId: enqueued } = await restore.mutateAsync({
        r2Key: upload.key,
        requestId: crypto.randomUUID(),
      });
      setRestoreJobId(enqueued);
    } catch (error) {
      showError(error, t('v3.settings.pending.restoringBackup'));
    } finally {
      setUploading(false);
    }
  };

  const making = create.isPending || jobId !== null;
  const restoring = uploading || restoreJobId !== null;
  const backup = latest.data;

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.backup.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.backup.intro')}</p>
        <p className="text-caption text-muted-foreground">{t('v3.settings.backup.notIncluded')}</p>
        {backup ? (
          <p className="text-caption text-muted-foreground">
            {t('v3.settings.backup.last', {
              date: formatDate(backup.createdAt),
              size: formatBytes(backup.byteSize),
            })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="gap-2"
          disabled={making}
          onClick={() => create.mutate({ requestId: crypto.randomUUID() })}
        >
          {making ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Archive className="size-4" aria-hidden="true" />
          )}
          {making ? t('v3.settings.backup.making') : t('v3.settings.backup.make')}
        </Button>
        {backup ? (
          <Button
            variant="outline"
            className="gap-2"
            disabled={making || fetching}
            onClick={() => void download(backup.id)}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('v3.settings.backup.download')}
          </Button>
        ) : null}
      </div>
      {restorable.data?.empty ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-label text-muted-foreground">
            {t('v3.settings.backup.restoreTitle')}
          </h3>
          <p className="text-body text-muted-foreground">{t('v3.settings.backup.restoreIntro')}</p>
          <input
            ref={picker}
            type="file"
            accept=".gz,application/gzip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void startRestore(file);
            }}
          />
          <div>
            <Button
              variant="outline"
              className="gap-2"
              disabled={restoring || making}
              onClick={() => picker.current?.click()}
            >
              {restoring ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArchiveRestore className="size-4" aria-hidden="true" />
              )}
              {restoring
                ? t('v3.settings.backup.restoring')
                : t('v3.settings.backup.restoreChoose')}
            </Button>
          </div>
        </div>
      ) : null}
    </Block>
  );
}
