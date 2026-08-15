import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block } from '@scani/ui/v3/components/Block';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { FiatCurrencySelect } from '@/v2/components/shared/FiatCurrencySelect';
import { invalidateVaultQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { Field, FieldRow } from '../components/form/Field';
import { GROUP_COLORS, GroupColorChoice } from '../components/groups/GroupColorChoice';
import { VaultsList } from '../components/vaults/VaultsList';
import { vaultDetailPath } from '../lib/routes';

/**
 * Savings goals.
 *
 * Creating one is an **inline block**, matching groups exactly — SC-70 replaced
 * v2's two-step `VaultFormDialog` here for the reasons in
 * `pages/GroupDetailPage.tsx`. Its second step picked holdings *before the
 * vault existed*, which is the same mistake the group wizard made: it asks for
 * membership at the one moment the reader has nothing to see it against. So
 * creating navigates to the vault's own page, where attaching a holding shows
 * its effect on the goal immediately.
 *
 * `FiatCurrencySelect` is borrowed from v2 rather than rebuilt. It is a select
 * of currencies with no v2 layout assumptions in it, and a vault's currency is
 * set once at creation and never again — see the note on the detail page.
 */
export function VaultsPage() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const vaultsQuery = trpc.vaults.getAll.useQuery();
  const baseCurrencyQuery = trpc.users.getBaseCurrency.useQuery();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currencyId, setCurrencyId] = useState('');
  const [color, setColor] = useState<string>(GROUP_COLORS[0]);

  // Default to the currency the rest of the app reports in, once it lands.
  useEffect(() => {
    if (!currencyId && baseCurrencyQuery.data?.id) setCurrencyId(baseCurrencyQuery.data.id);
  }, [baseCurrencyQuery.data, currencyId]);

  const openCreate = () => {
    setName('');
    setTargetAmount('');
    setColor(GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)] ?? GROUP_COLORS[0]);
    setCreating(true);
  };

  const createVault = trpc.vaults.create.useMutation({
    onSuccess: (vault) => {
      setCreating(false);
      showSuccess(`Vault “${vault.name}” created`);
      navigate(vaultDetailPath(vault.id));
    },
    onError: (error) => showError(error, 'Creating the vault'),
    onSettled: () => void invalidateVaultQueries(utils, { refetchType: 'all' }),
  });

  const missing = !name.trim()
    ? 'name the vault'
    : !(Number(targetAmount) > 0)
      ? 'set a target above zero'
      : !currencyId
        ? 'pick a currency'
        : null;
  const canCreate = missing === null && !createVault.isPending;

  const submit = () => {
    if (!canCreate) return;
    createVault.mutate({ name: name.trim(), targetAmount, currencyId, color });
  };

  return (
    <PageLayout measure="wide">
      <PageHeader
        title="Vaults"
        action={
          <Button onClick={openCreate} disabled={creating}>
            <Plus className="mr-1.5 size-4" aria-hidden="true" />
            New vault
          </Button>
        }
      />

      {creating ? (
        <Block className="flex flex-col gap-3 p-4">
          <Field label="Name" htmlFor="new-vault-name">
            <Input
              id="new-vault-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="House deposit, emergency fund…"
              disabled={createVault.isPending}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </Field>
          {/* Target and its currency are one decision, so they share a line
           *  above `lg` — the rule `FieldRow` exists for. */}
          <FieldRow>
            <Field label="Target" htmlFor="new-vault-target">
              <AmountInput
                id="new-vault-target"
                value={targetAmount}
                onValueChange={setTargetAmount}
                decimalScale={2}
                placeholder="25,000"
                disabled={createVault.isPending}
              />
            </Field>
            <Field label="Currency">
              <FiatCurrencySelect value={currencyId} onChange={setCurrencyId} />
            </Field>
          </FieldRow>
          <Field label="Colour">
            <GroupColorChoice value={color} onChange={setColor} disabled={createVault.isPending} />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={createVault.isPending}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={!canCreate} onClick={submit}>
              Create vault
            </Button>
            {missing ? (
              <p className="text-caption text-muted-foreground">{`To continue: ${missing}.`}</p>
            ) : null}
          </div>
        </Block>
      ) : null}

      <VaultsList
        vaults={vaultsQuery.data ?? []}
        query={mergeQueries(vaultsQuery)}
        onCreate={openCreate}
      />
    </PageLayout>
  );
}
