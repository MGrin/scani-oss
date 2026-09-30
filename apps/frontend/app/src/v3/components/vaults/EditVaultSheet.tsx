import { Input } from '@scani/ui/ui/input';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidateVaultQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { optimisticPatchVault } from '@/v3/hooks/optimisticUpdates';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { GroupColorChoice } from '../groups/GroupColorChoice';

interface EditableVault {
  id: string;
  name: string;
  color: string;
  targetAmount: string | number;
  currencySymbol: string;
}

export function EditVaultSheet({
  vault,
  open,
  onOpenChange,
}: {
  vault: EditableVault;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [name, setName] = useState(vault.name);
  const [targetAmount, setTargetAmount] = useState(String(vault.targetAmount));
  const [color, setColor] = useState(vault.color);
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed from the record each time the sheet opens, not on every refetch while it is open
  useEffect(() => {
    if (!open) return;
    setName(vault.name);
    setTargetAmount(String(vault.targetAmount));
    setColor(vault.color);
    setFailure(null);
  }, [open]);

  const updateVault = trpc.vaults.update.useMutation({
    onMutate: ({ id, data }) =>
      optimisticPatchVault(utils, id, {
        name: data.name,
        color: data.color,
        targetAmount: data.targetAmount,
      }),
    onSuccess: () => {
      onOpenChange(false);
      showSuccess(t('v3.vaults.detail.toast.updated'));
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      const copy = describeQueryError(error, t('v3.vaults.page.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSettled: () => void invalidateVaultQueries(utils),
  });

  const blockers = [
    ...(name.trim() ? [] : [t('v3.vaults.page.blocker.name')]),
    ...(Number(targetAmount) > 0 ? [] : [t('v3.vaults.page.blocker.target')]),
  ];
  const dirty =
    name !== vault.name || targetAmount !== String(vault.targetAmount) || color !== vault.color;
  const submit = () => {
    if (blockers.length > 0 || updateVault.isPending) return;
    if (!dirty) {
      onOpenChange(false);
      return;
    }
    updateVault.mutate({ id: vault.id, data: { name: name.trim(), color, targetAmount } });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.vaults.detail.editTitle')}
      description={t('v3.vaults.detail.editDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.vaults.detail.saveChanges')}
          pendingLabel={t('v3.vaults.detail.toast.updating')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={updateVault.isPending}
          error={failure}
        />
      }
    >
      <Field label={t('v3.vaults.detail.name')} htmlFor="vault-name">
        <Input
          id="vault-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={updateVault.isPending}
        />
      </Field>
      {/* The currency is not editable, deliberately: it is the unit every
       *  stored figure on this vault is already denominated in, so changing it
       *  would silently reinterpret the target and the saved amount rather
       *  than convert them. */}
      <Field
        label={t('v3.vaults.detail.target')}
        htmlFor="vault-target"
        hint={t('v3.vaults.detail.targetHint', { symbol: vault.currencySymbol })}
      >
        <AmountInput
          id="vault-target"
          value={targetAmount}
          onValueChange={setTargetAmount}
          decimalScale={2}
          disabled={updateVault.isPending}
        />
      </Field>
      <Field label={t('v3.vaults.detail.colour')}>
        <GroupColorChoice value={color} onChange={setColor} disabled={updateVault.isPending} />
      </Field>
    </FormSheet>
  );
}
