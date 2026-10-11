import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useRelativeTimeTick } from '@/v3/hooks/useRelativeTimeTick';
import { formatRelative } from '../../lib/relative-time';

/**
 * The opt-in bills calendar feed (SC-1654): turn it on, copy the link once,
 * get a new link, turn it off. The server keeps only a hash of the link, so it
 * cannot be shown again; a new one is the way back to a copyable link.
 */
export function BillCalendarSettings() {
  useRelativeTimeTick();
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [minted, setMinted] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const status = trpc.billCalendar.status.useQuery();
  const settle = () => void utils.billCalendar.status.invalidate();

  const enable = trpc.billCalendar.enable.useMutation({
    onSuccess: ({ url }) => setMinted(url),
    onError: (error) => showError(error, t('v3.settings.billCalendar.enabling')),
    onSettled: settle,
  });
  const rotate = trpc.billCalendar.rotate.useMutation({
    onSuccess: ({ url }) => {
      setMinted(url);
      setConfirmRotate(false);
    },
    onError: (error) => showError(error, t('v3.settings.billCalendar.rotating')),
    onSettled: settle,
  });
  const disable = trpc.billCalendar.disable.useMutation({
    onSuccess: () => {
      setMinted(null);
      setConfirmDisable(false);
      showSuccess(t('v3.settings.billCalendar.disabled'));
    },
    onError: (error) => showError(error, t('v3.settings.billCalendar.disabling')),
    onSettled: settle,
  });

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.billCalendar.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.billCalendar.intro')}</p>
        <p className="text-caption text-muted-foreground">
          {t('v3.settings.billCalendar.warning')}
        </p>
      </div>

      {minted ? (
        <div className="mx-4 mb-4 flex flex-col gap-2 rounded-md border border-border p-3">
          <p className="text-body">{t('v3.settings.billCalendar.copyOnce')}</p>
          <code className="break-all text-caption">{minted}</code>
          <div className="flex flex-wrap gap-2">
            {/* One tap subscribes on iPhone and macOS; Google and Outlook take the copied link. */}
            <Button asChild size="sm">
              <a href={minted.replace(/^https?:/, 'webcal:')}>
                {t('v3.settings.billCalendar.addToCalendar')}
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(minted)
                  .then(() => showSuccess(t('v3.settings.billCalendar.copied')))
              }
            >
              {t('v3.settings.billCalendar.copy')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMinted(null)}>
              {t('v3.settings.billCalendar.done')}
            </Button>
          </div>
        </div>
      ) : null}

      {status.isError ? (
        <div className="p-4 pt-0">
          <QueryError
            error={status.error}
            subject={t('v3.settings.billCalendar.subject')}
            onRetry={() => void status.refetch()}
          />
        </div>
      ) : status.isLoading ? (
        <div className="p-4 pt-0">
          <Skeleton className="h-10 w-full" aria-hidden="true" />
        </div>
      ) : status.data?.enabled ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2">
          <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
            {status.data.createdAt
              ? t('v3.settings.billCalendar.since', {
                  when: formatRelative(t, status.data.createdAt),
                })
              : null}
          </p>
          <ConfirmAction
            label={t('v3.settings.billCalendar.rotate')}
            confirmLabel={t('v3.settings.billCalendar.rotateConfirm')}
            consequence={t('v3.settings.billCalendar.rotateConsequence')}
            open={confirmRotate}
            onOpenChange={setConfirmRotate}
            isPending={rotate.isPending}
            onConfirm={() => rotate.mutate()}
          />
          <ConfirmAction
            label={t('v3.settings.billCalendar.disable')}
            triggerClassName="text-destructive hover:text-destructive"
            destructive
            confirmLabel={t('v3.settings.billCalendar.disableConfirm')}
            consequence={t('v3.settings.billCalendar.disableConsequence')}
            open={confirmDisable}
            onOpenChange={setConfirmDisable}
            isPending={disable.isPending}
            onConfirm={() => disable.mutate()}
          />
        </div>
      ) : (
        <div className="px-4 pb-4">
          <Button onClick={() => enable.mutate()} disabled={enable.isPending}>
            {t('v3.settings.billCalendar.enable')}
          </Button>
        </div>
      )}
    </Block>
  );
}
