import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Delete one account, from the peek sheet that account is open in (SC-1746).
 *
 * Until this the only way to delete an account was the bulk bar, behind a row
 * checkbox on desktop and the toolbar's Select on a phone — a path nobody found.
 * It asks the way `HoldingDeleteAction` and `BulkDeleteAction` ask (SC-73): an
 * inline `ConfirmAction` that leads with Cancel and commits on a button
 * labelled with the account's name, never on the trigger's second tap.
 *
 * The consequence names what a reader cannot see from the sheet: the net worth
 * chart is rebuilt without this account, so every past day drops by its value,
 * and the realized gains recorded in it go too.
 */

interface AccountDeleteActionProps {
  name: string;
  onDelete: () => void;
  isPending?: boolean;
}

export function AccountDeleteAction({ name, onDelete, isPending }: AccountDeleteActionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <ConfirmAction
      label={
        <>
          <Trash2 className="me-2 size-4" aria-hidden="true" />
          {t('v3.entities.account.deleteAction.trigger')}
        </>
      }
      triggerClassName="text-destructive hover:text-destructive"
      confirmLabel={t('v3.entities.account.deleteAction.commit', { name })}
      destructive
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={t('v3.entities.account.deleteAction.consequence', { name })}
      onConfirm={onDelete}
    />
  );
}
