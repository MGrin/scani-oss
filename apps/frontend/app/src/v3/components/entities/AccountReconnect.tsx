import { Button } from '@scani/ui/ui/button';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { reconnectHref } from '../../lib/accounts';

/** The provider refused this account's key; only its owner can replace it (SC-1686). */
export function AccountReconnect({ providerKey }: { providerKey: string | null }) {
  const { t } = useTranslation();
  return (
    <Button asChild variant="outline" size="sm">
      <Link to={reconnectHref(providerKey)}>
        <KeyRound className="me-2 size-4" aria-hidden="true" />
        {t('v3.entities.account.keyRejectedReconnect')}
      </Link>
    </Button>
  );
}
