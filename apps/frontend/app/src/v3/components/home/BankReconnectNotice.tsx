import { Button } from '@scani/ui/ui/button';
import { Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { integrationConnectPath } from '../../lib/routes';

export function countNeedingReconnect(
  connections: readonly { needsReconnect: boolean }[] | undefined
): number {
  return (connections ?? []).filter((connection) => connection.needsReconnect).length;
}

/**
 * A linked bank whose consent ran out stops syncing without an error anywhere
 * (SC-1244), so its balances on this screen quietly age. A line in the
 * `StaleNotice` shape, not a banner: it qualifies the figures below it.
 */
export function BankReconnectLine({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-border-strong px-3 py-2"
    >
      <Unplug className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-caption text-muted-foreground">
        {t('v3.home.bankReconnect.notice', { count })}
      </p>
      <Button asChild variant="outline" size="sm">
        <Link to={integrationConnectPath('saltedge')}>{t('v3.home.bankReconnect.action')}</Link>
      </Button>
    </div>
  );
}

export function useBanksNeedingReconnect(): number {
  const connections = trpc.saltedge.connections.useQuery(undefined, { staleTime: 5 * 60_000 });
  return countNeedingReconnect(connections.data);
}
