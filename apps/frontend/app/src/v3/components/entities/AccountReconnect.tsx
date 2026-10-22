import { Button } from '@scani/ui/ui/button';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { reconnectHref } from '../../lib/accounts';

/** The provider refused this account's key; only its owner can replace it (SC-1686). */
export function AccountReconnect({
  providerKey,
  label,
}: {
  providerKey: string | null;
  /** From `keyRejectedLabels`; the reconnect wording when absent (SC-1733). */
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button asChild variant="outline" size="sm">
      <Link to={reconnectHref(providerKey)}>
        <KeyRound className="me-2 size-4" aria-hidden="true" />
        {label ?? t('v3.entities.account.keyRejectedReconnect')}
      </Link>
    </Button>
  );
}
