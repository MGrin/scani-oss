import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isValidVaultPercentage,
  type VaultHoldingRow as VaultHoldingRowData,
} from '../../lib/vaults';
import { Field } from '../form/Field';
import { EditAction, FormActions, FormSheet } from '../form/FormSheet';

/**
 * A vault member's share, edited the way every record is (UI standard rule 13,
 * SC-1433): Edit in its peek's header opens a `FormSheet`. Until SC-1433 it sat
 * loose in the peek's body behind an icon-only pencil that swapped the figure
 * for an input in place. Remove is `RemoveFromVaultAction`, beside it.
 */
export function EditVaultShareAction({
  holding,
  onSave,
}: {
  holding: VaultHoldingRowData;
  onSave: (holdingId: string, percentage: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EditAction onClick={() => setOpen(true)} />
      {/* Mounted only while open, so each opening seeds from the share on file. */}
      {open ? (
        <EditVaultShareSheet holding={holding} onSave={onSave} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}

function EditVaultShareSheet({
  holding,
  onSave,
  onOpenChange,
}: {
  holding: VaultHoldingRowData;
  onSave: (holdingId: string, percentage: number) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [share, setShare] = useState(String(holding.percentage));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const valid = isValidVaultPercentage(Number(share));

  const submit = async () => {
    if (!valid || pending) return;
    if (Number(share) === holding.percentage) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    try {
      await onSave(holding.holdingId, Number(share));
      onOpenChange(false);
    } catch {
      setFailure(t('v3.vaults.holding.saveFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.vaults.holding.editTitle')}
      description={t('v3.vaults.holding.editDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.form.saveChanges')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={() => void submit()}
          onCancel={() => onOpenChange(false)}
          blockers={valid ? [] : [t('v3.vaults.holding.shareBlocker')]}
          pending={pending}
          error={failure}
        />
      }
    >
      <Field
        label={t('v3.vaults.holding.shareField')}
        htmlFor="vault-share"
        hint={t('v3.vaults.holding.shareRange')}
      >
        <AmountInput
          id="vault-share"
          value={share}
          onValueChange={setShare}
          decimalScale={2}
          suffix="%"
          disabled={pending}
        />
      </Field>
    </FormSheet>
  );
}
