import { cn } from '@scani/ui/lib/cn';
import { Button } from '@scani/ui/ui/button';
import { UserX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * An account deletion the owner asked for that has not finished (SC-1276).
 *
 * "Delete my account" signs out the moment the job is queued, because the job
 * removes the session the page is running on. So a job that then fails leaves
 * an account its owner believes is gone, and the next sign-in is the only
 * place left to say so. A completed deletion leaves no row, so the query is
 * `null` on every screen of every normal account.
 */

interface Deletion {
  jobId: string;
  failed: boolean;
  message: string | null;
}

export function AccountDeletionNoticeView({
  deletion,
  onRetry,
  retrying,
  className,
}: {
  deletion: Deletion | null;
  onRetry: () => void;
  retrying: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!deletion) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-strong px-3 py-2',
        className
      )}
    >
      <UserX className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-caption text-muted-foreground">
        {deletion.failed ? (
          <>
            <span>{t('v3.settings.accountDeletion.failed')}</span>{' '}
            <span>{deletion.message ?? t('v3.settings.accountDeletion.failedFallback')}</span>
          </>
        ) : (
          t('v3.settings.accountDeletion.pending')
        )}
      </p>
      {deletion.failed ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          {t('v3.settings.accountDeletion.retry')}
        </Button>
      ) : null}
    </div>
  );
}
