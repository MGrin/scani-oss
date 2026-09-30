import { Input } from '@scani/ui/ui/input';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { invalidateVaultQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { vaultDetailPath } from '../../lib/routes';
import { FiatCurrencyField } from '../form/FiatCurrencyField';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { GROUP_COLORS, GroupColorChoice } from '../groups/GroupColorChoice';

/**
 * Creating a savings goal. Holdings are attached on the vault's own page, where
 * each one's effect on the goal shows at once, so creating navigates there. The
 * currency is set once, here, and never again (see the vault detail page).
 */
export function CreateVaultSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const baseCurrencyQuery = trpc.users.getBaseCurrency.useQuery();
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currencyId, setCurrencyId] = useState('');
  const [color, setColor] = useState<string>(GROUP_COLORS[0]);
  const [failure, setFailure] = useState<string | null>(null);
  const baseCurrencyId = baseCurrencyQuery.data?.id ?? '';

  useEffect(() => {
    if (!open) return;
    setName('');
    setTargetAmount('');
    setCurrencyId(baseCurrencyId);
    setColor(GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)] ?? GROUP_COLORS[0]);
    setFailure(null);
  }, [open, baseCurrencyId]);

  const createVault = trpc.vaults.create.useMutation({
    onSuccess: (vault) => {
      onOpenChange(false);
      showSuccess(t('v3.vaults.page.created', { name: vault.name }));
      navigate(vaultDetailPath(vault.id));
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.vaults.page.subject'), 'create');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSettled: () => void invalidateVaultQueries(utils, { refetchType: 'all' }),
  });

  const blockers = [
    ...(name.trim() ? [] : [t('v3.vaults.page.blocker.name')]),
    ...(Number(targetAmount) > 0 ? [] : [t('v3.vaults.page.blocker.target')]),
    ...(currencyId ? [] : [t('v3.vaults.page.blocker.currency')]),
  ];
  const submit = () => {
    if (blockers.length > 0 || createVault.isPending) return;
    createVault.mutate({ name: name.trim(), targetAmount, currencyId, color });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.vaults.page.newVault')}
      description={t('v3.vaults.page.sheetDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.vaults.page.createVault')}
          pendingLabel={t('v3.vaults.page.creating')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={createVault.isPending}
          error={failure}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('v3.vaults.page.name')} htmlFor="new-vault-name">
          <Input
            id="new-vault-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('v3.vaults.page.namePlaceholder')}
            disabled={createVault.isPending}
          />
        </Field>
        <Field label={t('v3.vaults.page.target')} htmlFor="new-vault-target">
          <AmountInput
            id="new-vault-target"
            value={targetAmount}
            onValueChange={setTargetAmount}
            decimalScale={2}
            placeholder="25,000"
            disabled={createVault.isPending}
          />
        </Field>
        <Field label={t('v3.vaults.page.currency')} htmlFor="new-vault-currency">
          <FiatCurrencyField
            id="new-vault-currency"
            value={currencyId}
            onChange={setCurrencyId}
            disabled={createVault.isPending}
          />
        </Field>
        <Field label={t('v3.vaults.page.colour')}>
          <GroupColorChoice value={color} onChange={setColor} disabled={createVault.isPending} />
        </Field>
      </div>
    </FormSheet>
  );
}
