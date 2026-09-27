import { showError } from '@scani/ui/ui/use-toast';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { trpc } from '@/lib/trpc';
import { AccountDeletionNoticeView } from './AccountDeletionNoticeView';

// The view lives in its own module so its test never loads the auth client,
// which refuses to initialise without VITE_API_URL.
export function AccountDeletionNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const deletion = trpc.users.accountDeletion.useQuery();
  const retry = trpc.users.deleteAccount.useMutation({
    onSuccess: () => void signOut(),
    onError: (error) => showError(error, t('v3.settings.pending.deletingData')),
  });
  return (
    <AccountDeletionNoticeView
      deletion={deletion.data ?? null}
      onRetry={() => retry.mutate({ requestId: crypto.randomUUID() })}
      retrying={retry.isPending}
      className={className}
    />
  );
}
