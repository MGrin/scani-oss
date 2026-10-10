import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { PlugZap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useRelativeTimeTick } from '@/v3/hooks/useRelativeTimeTick';
import { formatRelative } from '../../lib/relative-time';

/**
 * Apps connected through Scani's OAuth sign-in, such as claude.ai (SC-1615).
 * Disconnecting removes the consent and every token it issued, so the app
 * stops reading at once. Hidden while there is nothing to show.
 */
export function ConnectedAppsSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const apps = trpc.agentTokens.connectedApps.useQuery();
  const disconnect = trpc.agentTokens.disconnectApp.useMutation({
    onSuccess: () => showSuccess(t('v3.settings.connectedApps.disconnected')),
    onError: (error) => showError(error, t('v3.settings.connectedApps.disconnecting')),
    onSettled: () => void utils.agentTokens.connectedApps.invalidate(),
  });

  if (apps.isLoading || (apps.data ?? []).length === 0) {
    return apps.isError ? (
      <Block className="p-4">
        <QueryError
          error={apps.error}
          subject={t('v3.settings.connectedApps.subject')}
          onRetry={() => void apps.refetch()}
        />
      </Block>
    ) : null;
  }

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.connectedApps.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.connectedApps.intro')}</p>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {(apps.data ?? []).map((app) => (
          <ConnectedAppRow
            key={app.clientId}
            name={app.name ?? t('oauth.consent.unnamedApp')}
            connectedAt={app.connectedAt}
            isPending={disconnect.isPending}
            onDisconnect={() => disconnect.mutate({ clientId: app.clientId })}
          />
        ))}
      </ul>
    </Block>
  );
}

interface ConnectedAppRowProps {
  name: string;
  connectedAt: string | Date;
  isPending: boolean;
  onDisconnect: () => void;
}

function ConnectedAppRow({ name, connectedAt, isPending, onDisconnect }: ConnectedAppRowProps) {
  useRelativeTimeTick();
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <PlugZap className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">{name}</p>
        <p className="truncate text-caption text-muted-foreground">
          {t('v3.settings.connectedApps.connected', { when: formatRelative(t, connectedAt) })}
        </p>
      </div>
      <ConfirmAction
        label={t('v3.settings.connectedApps.disconnect')}
        triggerClassName="text-destructive hover:text-destructive"
        destructive
        confirmLabel={t('v3.settings.connectedApps.disconnectConfirm', { name })}
        consequence={t('v3.settings.connectedApps.disconnectConsequence')}
        open={confirming}
        onOpenChange={setConfirming}
        isPending={isPending}
        onConfirm={onDisconnect}
      />
    </li>
  );
}
