import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { connectErrorCopy } from '../../lib/connect-error';
import { FieldSet } from '../form/Field';

export interface BankConnection {
  connectionId: string;
  status: string;
  lastError: string | null;
  needsReconnect: boolean;
}

/**
 * The user's linked banks and which of them stopped syncing (SC-1244). A
 * bank's consent runs out — about 90 days in the UK, up to 180 in the EU — and
 * the connection then goes quiet rather than failing, so this is the one
 * place that says so and offers the way back.
 */
export function BankReconnectRows({
  connections,
  onReconnect,
  pendingId,
}: {
  connections: BankConnection[];
  onReconnect: (connectionId: string) => void;
  pendingId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col divide-y divide-border">
      {connections.map((connection, index) => (
        <li
          key={connection.connectionId}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
        >
          <div className="min-w-0">
            <p className="text-body">
              {t('v3.capture.integration.redirect.banks.label', { n: index + 1 })}
            </p>
            <p
              className={
                connection.needsReconnect
                  ? 'text-caption text-destructive'
                  : 'text-caption text-muted-foreground'
              }
            >
              {connection.needsReconnect
                ? t('v3.capture.integration.redirect.banks.needsReconnect')
                : t('v3.capture.integration.redirect.banks.syncing')}
            </p>
          </div>
          {connection.needsReconnect ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pendingId !== null}
              onClick={() => onReconnect(connection.connectionId)}
            >
              {t('v3.capture.integration.redirect.banks.reconnect')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function BankReconnectList({ institutionName }: { institutionName: string }) {
  const { t } = useTranslation();
  const connections = trpc.saltedge.connections.useQuery();
  const startReconnect = trpc.saltedge.startReconnect.useMutation();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = connections.data ?? [];
  if (rows.length === 0) return null;

  const reconnect = async (connectionId: string) => {
    setError(null);
    setPendingId(connectionId);
    try {
      const { connectUrl } = await startReconnect.mutateAsync({ connectionId });
      window.location.assign(connectUrl);
    } catch (err) {
      const copy = connectErrorCopy(t, err, institutionName);
      setError(`${copy.title}. ${copy.detail}`);
      setPendingId(null);
    }
  };

  return (
    <Block>
      <FieldSet title={t('v3.capture.integration.redirect.banks.title')}>
        {rows.some((row) => row.needsReconnect) ? (
          <p className="text-caption text-muted-foreground">
            {t('v3.capture.integration.redirect.banks.hint')}
          </p>
        ) : null}
        <BankReconnectRows connections={rows} onReconnect={reconnect} pendingId={pendingId} />
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
      </FieldSet>
    </Block>
  );
}
