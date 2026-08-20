import { formatCurrency } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Progress } from '@scani/ui/ui/progress';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportMoney, exportPercent } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { PiggyBank } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { vaultDetailPath } from '../../lib/routes';
import {
  compareVaults,
  type VaultRow,
  vaultIsMet,
  vaultProgress,
  vaultRemaining,
  vaultSaved,
} from '../../lib/vaults';

/**
 * Savings goals, as a list rather than a card grid.
 *
 * v2 renders three-across cards with a progress bar in each, which on a 393px
 * phone is one card per screen and a `text-xs` percentage under it. A vault is
 * a name and two numbers, which is a row: saved, how far that is along, and
 * what is left.
 *
 * Rows navigate — see `vaultDetailPath`. A vault's members are editable, and an
 * editable list inside a half-height sheet is two dismiss gestures deep.
 */

interface VaultsListProps {
  vaults: VaultRow[];
  query: V3QueryState;
  onCreate: () => void;
}

/**
 * The bar plus its percentage — the desktop table's progress column.
 *
 * Deliberately *not* on the phone row. `<DataRow>`'s sublabel is a `<span>`
 * that truncates, and Radix's `Progress` is a `<div>`: a block element inside
 * an inline one is invalid nesting, and `truncate` would clip it to nothing
 * anyway. The row says the same thing in words ("52% of €10,000"), which is
 * what the three-zone signature is for — the bar is a table's luxury.
 */
function VaultProgressCell({ vault }: { vault: VaultRow }) {
  const progress = vaultProgress(vault);
  return (
    <div className="flex items-center gap-2">
      <Progress value={progress} className="h-1 min-w-0 flex-1" />
      <span className="shrink-0 font-mono tabular-nums tracking-numeric">
        {`${Math.round(progress)}%`}
      </span>
    </div>
  );
}

export function VaultsList({ vaults, query, onCreate }: VaultsListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const config: V3DataViewConfig<VaultRow> = {
    pageKey: 'vaults',
    data: vaults,
    nounKey: 'ui.dataView.noun.vaults',
    searchPlaceholderKey: 'ui.dataView.vaults.config.searchVaults',
    searchFn: (vault, query) => vault.name.toLowerCase().includes(query),
    filterDefs: [
      {
        key: 'status',
        labelKey: 'ui.dataView.vaults.filter.status',
        options: [
          { value: 'open', labelKey: 'ui.dataView.vaults.option.stillSaving' },
          { value: 'met', labelKey: 'ui.dataView.vaults.option.targetReached' },
        ],
        fn: (vault: VaultRow, value) => (value === 'met' ? vaultIsMet(vault) : !vaultIsMet(vault)),
      },
    ],
    sortDefs: [
      { key: 'saved', labelKey: 'ui.dataView.vaults.sort.saved' },
      { key: 'progress', labelKey: 'ui.dataView.vaults.sort.progress' },
      { key: 'target', labelKey: 'ui.dataView.vaults.sort.target' },
      { key: 'name', labelKey: 'ui.dataView.vaults.sort.name' },
    ],
    sortFn: compareVaults,
    defaultSort: { field: 'saved', direction: 'desc' },
    renderRow: (vault) => ({
      // The vault's colour is its identity everywhere else in the app, so it is
      // the leading mark here rather than a stripe the row has to make room for.
      leading: (
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: vault.color }}
        />
      ),
      label: vault.name,
      // A string, not a `<Numeric>`: the sublabel is one sentence about how far
      // along the goal is, and splitting it into three nodes to get tabular
      // figures on the target would break the line at every width.
      sublabel: `${Math.round(vaultProgress(vault))}% of ${formatCurrency(vault.targetAmount, vault.currencySymbol, { decimals: 0 })}`,
      value: <Numeric value={vaultSaved(vault)} currency={vault.currencySymbol} decimals={0} />,
      delta: (
        <span className="text-muted-foreground">
          {vaultIsMet(vault) ? (
            t('v3.vaults.targetReached')
          ) : (
            <>
              <Numeric value={vaultRemaining(vault)} currency={vault.currencySymbol} decimals={0} />
              {' to go'}
            </>
          )}
        </span>
      ),
      ariaLabel: t('v3.vaults.list.rowSpoken', {
        name: vault.name,
        percent: Math.round(vaultProgress(vault)),
      }),
    }),
    columns: [
      {
        key: 'name',
        headerKey: 'ui.dataView.vaults.col.vault',
        sortable: true,
        width: 'w-[28%]',
        render: (vault) => (
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: vault.color }}
            />
            <span className="truncate text-label">{vault.name}</span>
          </span>
        ),
      },
      {
        key: 'progressBar',
        headerKey: 'ui.dataView.vaults.col.progress',
        render: (vault) => <VaultProgressCell vault={vault} />,
        exportValue: (vault) => exportPercent(vault.progress),
      },
      {
        key: 'saved',
        headerKey: 'ui.dataView.vaults.col.saved',
        sortable: true,
        numeric: true,
        render: (vault) => (
          <Numeric value={vaultSaved(vault)} currency={vault.currencySymbol} decimals={0} />
        ),
        exportValue: (vault) => exportMoney(vault.currentAmount, vault.currencySymbol),
        exportTotal: true,
      },
      {
        key: 'target',
        headerKey: 'ui.dataView.vaults.col.target',
        sortable: true,
        numeric: true,
        render: (vault) => (
          <Numeric value={vault.targetAmount} currency={vault.currencySymbol} decimals={0} />
        ),
        exportValue: (vault) => exportMoney(vault.targetAmount, vault.currencySymbol),
        exportTotal: true,
      },
    ],
    empty: {
      icon: PiggyBank,
      titleKey: 'ui.dataView.vaults.empty.noVaultsYet',
      descriptionKey: 'ui.dataView.vaults.empty.aVaultIsASavingsGoal',
      action: <Button onClick={onCreate}>{t('v3.vaults.createFirst')}</Button>,
    },
    onRowClick: (vault) => navigate(vaultDetailPath(vault.id)),
    rowHref: (vault) => vaultDetailPath(vault.id),
  };

  return <V3DataView config={config} getId={(vault) => vault.id} query={query} />;
}
