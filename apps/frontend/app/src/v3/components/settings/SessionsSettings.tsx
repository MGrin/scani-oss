import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { DataRowList } from '@scani/ui/v3/components/DataRow';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import {
  optimisticRevokeOtherSessions,
  optimisticRevokeSession,
} from '@/v3/hooks/optimisticUpdates';
import { SessionRow } from './SessionRow';

/**
 * Where the account is signed in, and how to end any of it.
 *
 * A run of rows of the same shape, so `<DataRowList>` rather than the bordered
 * `<li>` boxes v2 draws — the §4.3 rule, and here it is the difference between
 * six devices fitting on a phone screen and four.
 *
 * Both writes on this screen confirm (SC-73). They did not, and `Revoke` sat
 * one tap away from a row identified by a user-agent string and an IP — two
 * fields a reader cannot reliably tell apart on a phone when the same browser
 * appears six times. `Sign out everywhere else` was worse: one tap ended every
 * session but this one, with the count in the trigger's own label as the only
 * warning. Neither is `destructive`-red: signing in again is an exact inverse,
 * and the red belongs to the writes that have none.
 *
 * The current device's Revoke is disabled rather than hidden. Hiding it makes
 * the row look like a different kind of thing; disabling it with the label
 * saying "this device" says what is actually true — signing out *here* is the
 * button in the block below, which does the same thing and tells you it will.
 */
export function SessionsSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [confirmingOthers, setConfirmingOthers] = useState(false);
  const sessionsQuery = trpc.sessions.list.useQuery(undefined, { refetchOnWindowFocus: true });

  const settle = () => void utils.sessions.list.invalidate();

  const revoke = trpc.sessions.revoke.useMutation({
    onMutate: ({ token }) => optimisticRevokeSession(utils, token),
    onSuccess: () => showSuccess(t('v3.settings.sessions.revoked')),
    onError: (error, _variables, context) => {
      context?.restore();
      showError(error, t('v3.settings.pending.revokingSession'));
    },
    onSettled: settle,
  });

  const revokeOthers = trpc.sessions.revokeOthers.useMutation({
    onMutate: () => optimisticRevokeOtherSessions(utils),
    onSuccess: () => {
      setConfirmingOthers(false);
      showSuccess(t('v3.settings.sessions.signedOutOthers'));
    },
    onError: (error, _variables, context) => {
      context?.restore();
      showError(error, t('v3.settings.pending.signingOutOthers'));
    },
    onSettled: settle,
  });

  const sessions = sessionsQuery.data ?? [];
  const otherCount = sessions.filter((session) => !session.isCurrent).length;

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.sessions.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.sessions.intro')}</p>
      </div>

      {sessionsQuery.isError ? (
        <div className="p-4 pt-0">
          <QueryError
            error={sessionsQuery.error}
            subject={t('v3.settings.sessions.subject')}
            onRetry={() => void sessionsQuery.refetch()}
          />
        </div>
      ) : sessionsQuery.isLoading ? (
        <div className="flex flex-col gap-2 p-4 pt-0">
          <Skeleton className="h-10 w-full" aria-hidden="true" />
          <Skeleton className="h-10 w-full" aria-hidden="true" />
        </div>
      ) : sessions.length === 0 ? (
        <p className="p-4 pt-0 text-body text-muted-foreground">
          {t('v3.settings.sessions.empty')}
        </p>
      ) : (
        <DataRowList className="border-t border-border">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isPending={revoke.isPending}
              onRevoke={(token) => revoke.mutate({ token })}
            />
          ))}
        </DataRowList>
      )}

      {otherCount > 0 ? (
        <div className="border-t border-border p-4">
          <ConfirmAction
            label={t('v3.settings.sessions.signOutOthers', { count: otherCount })}
            // The count moves into the commit too. The trigger carries it
            // because it is also the answer to "how many are there"; the
            // commit carries it because that is the button being pressed.
            confirmLabel={t('v3.settings.sessions.signOutOthersConfirm', {
              count: otherCount,
            })}
            open={confirmingOthers}
            onOpenChange={setConfirmingOthers}
            isPending={revokeOthers.isPending}
            // One pluralised key per branch, not a ternary inside a template:
            // English has two forms and the rule is "if it varies on a count,
            // it is a plural key" (SC-201). Russian and Arabic have more, and a
            // ternary can only ever produce two.
            consequence={t('v3.settings.sessions.signOutOthersConsequence', {
              count: otherCount,
            })}
            onConfirm={() => revokeOthers.mutate()}
          />
        </div>
      ) : null}
    </Block>
  );
}
