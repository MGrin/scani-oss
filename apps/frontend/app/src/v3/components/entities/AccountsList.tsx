import { formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { BulkDeleteAction } from '@scani/ui/v3/components/data-view/BulkDeleteAction';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { nameList, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportCount, exportMoney, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { PieChart, Tags, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  type AccountRow,
  accountLastSync,
  accountsValue,
  accountValue,
  compareAccounts,
  isStaleSync,
  namedAllocation,
} from '../../lib/accounts';
import { V3_ROUTES } from '../../lib/routes';
import { useOpenCapture } from '../capture/CaptureSheetContext';
import { EntityValueSummary } from './EntityValueSummary';
import { InstitutionMark } from './InstitutionMark';

/**
 * The accounts a portfolio is held in.
 *
 * §2.1 folded accounts into Holdings as a *dimension* and V3-12 shipped that,
 * which leaves this surface a different question: not "what do I hold" but
 * "what containers exist, what is in each, and when did each last sync". So the
 * peek's first action is the link back into the holdings list already narrowed
 * to this account — `?account=<id>`, v2's own parameter name, because that
 * spelling is the contract that lets the version switch carry a filtered view
 * across.
 *
 * v2 hides zero-holding accounts behind a "Show 4 empty" toggle in the page
 * header — a bespoke control that duplicates what filtering already is. Here it
 * is a filter option like any other, so it appears in the same sheet as the
 * rest and says so in a chip when it is on.
 */

interface Named {
  id: string;
  name: string;
  website?: string | null;
}

export interface AccountsListProps {
  accounts: AccountRow[];
  currency: string;
  institutions: readonly Named[] | undefined;
  accountTypes: readonly Named[] | undefined;
  groups: readonly Named[] | undefined;
  /** Seeded from the URL — see `accountFiltersFromParams`. */
  defaultFilters: Record<string, string>;
  query: V3QueryState;
  onAssignGroups: (ids: string[], clearSelection: () => void) => void;
  onBulkDelete: (ids: string[], clearSelection: () => void) => void;
  /** True while `accounts.bulkDelete` is in flight. */
  isBulkDeleting?: boolean;
}

/** The names behind a selection, for the confirmation to be checkable against
 *  the rows still on screen behind it. */
export function selectedNames(
  accounts: readonly AccountRow[],
  selectedIds: ReadonlySet<string>
): string {
  return nameList(accounts.filter((item) => selectedIds.has(item.id)).map((item) => item.name));
}

function nameById(items: readonly Named[] | undefined): Map<string, Named> {
  return new Map((items ?? []).map((item) => [item.id, item]));
}

/** Options for the entities actually referenced by a row, so a filter can never
 *  offer a value that matches nothing. */
function referencedOptions(
  known: Map<string, Named>,
  referencedIds: readonly string[]
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const id of referencedIds) {
    if (!seen.has(id)) seen.set(id, known.get(id)?.name ?? id);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function AccountsList({
  accounts,
  currency,
  institutions,
  accountTypes,
  groups,
  defaultFilters,
  query,
  onAssignGroups,
  onBulkDelete,
  isBulkDeleting,
}: AccountsListProps) {
  const openCapture = useOpenCapture();
  const institutionById = nameById(institutions);
  const typeById = nameById(accountTypes);

  const institutionName = (account: AccountRow) =>
    institutionById.get(account.institutionId)?.name ?? 'Unknown institution';
  const typeName = (account: AccountRow) => typeById.get(account.typeId)?.name ?? 'Unknown type';

  /**
   * The whole answer — for the peek and for the file, where there is room for
   * a sentence and a reader who has asked about this one account.
   */
  const lastSyncFact = (account: AccountRow) => {
    const lastSync = accountLastSync(account.metadata);
    if (!lastSync) return 'Never — this account is maintained by hand';
    return isStaleSync(lastSync)
      ? `${formatRelative(lastSync)} · overdue`
      : formatRelative(lastSync);
  };

  /**
   * The column's answer (SC-114, second half). The sentence above was a badge's
   * job written as prose: repeated identically down all ten rows and cut to
   * "Never — this accou…" on every one of them, which reads as an error where
   * the real message is that nothing is wrong. Two words say the same thing and
   * fit; the sentence stays one tap away in the peek, and the export writes it
   * in full.
   */
  const lastSyncCell = (account: AccountRow) =>
    accountLastSync(account.metadata) ? lastSyncFact(account) : 'By hand';

  const config: V3DataViewConfig<AccountRow> = {
    pageKey: 'accounts',
    data: accounts,
    noun: 'accounts',
    // Just "Search". This is the one surface here whose toolbar carries three
    // controls — Refine *and* Select — and at 393px "Search accounts" is
    // clipped by the input's own edge to "Search account", which reads as a
    // different, wrong word. The `aria-label` `V3DataView` derives from `noun`
    // still says "Search accounts", so nothing is lost to a screen reader.
    searchPlaceholder: 'Search',
    defaultFilters,
    searchFn: (account, query) =>
      account.name.toLowerCase().includes(query) ||
      institutionName(account).toLowerCase().includes(query),
    filterDefs: [
      {
        key: 'institution',
        label: 'Institution',
        options: referencedOptions(
          institutionById,
          accounts.map((account) => account.institutionId)
        ),
        fn: (account: AccountRow, value) => account.institutionId === value,
      },
      {
        key: 'type',
        label: 'Type',
        options: referencedOptions(
          typeById,
          accounts.map((account) => account.typeId)
        ),
        fn: (account: AccountRow, value) => account.typeId === value,
      },
      {
        key: 'group',
        label: 'Group',
        options: (groups ?? []).map((group) => ({ value: group.id, label: group.name })),
        fn: (account: AccountRow, value) => account.groups.some((group) => group.id === value),
      },
      {
        key: 'contents',
        label: 'Contents',
        options: [
          { value: 'holding', label: 'Holds something' },
          { value: 'empty', label: 'Empty' },
        ],
        fn: (account: AccountRow, value) =>
          value === 'empty'
            ? account.summary.holdingsCount === 0
            : account.summary.holdingsCount > 0,
      },
    ],
    sortDefs: [
      { key: 'value', label: 'Value' },
      { key: 'name', label: 'Name' },
      { key: 'holdings', label: 'Holdings' },
    ],
    sortFn: compareAccounts,
    defaultSort: { field: 'value', direction: 'desc' },
    groupByDefs: [
      { key: 'institution', label: 'Institution', fn: institutionName },
      { key: 'type', label: 'Type', fn: typeName },
    ],
    summary: (items) => (
      <EntityValueSummary
        value={accountsValue(items)}
        currency={currency}
        allocation={namedAllocation(items, accountValue)}
        allocationLabel="Value by account"
      />
    ),
    renderRow: (account) => {
      const stale = isStaleSync(accountLastSync(account.metadata));
      return {
        leading: (
          <InstitutionMark
            name={institutionName(account)}
            website={institutionById.get(account.institutionId)?.website}
            size="size-5"
          />
        ),
        label: account.name,
        sublabel: `${institutionName(account)} · ${account.summary.holdingsCount} ${account.summary.holdingsCount === 1 ? 'holding' : 'holdings'}`,
        value: <Numeric value={accountValue(account)} currency={currency} />,
        // The badge goes in the delta zone, not next to the name. The identity
        // zone truncates — that is its job — and "Ledger Nano — cold storage"
        // is long enough on a 393px row to clip the badge down to the left
        // edge of its own border, which renders as a stray arc that says
        // nothing. The value zone never truncates, which is exactly what a
        // warning needs.
        delta: stale ? (
          <Badge variant="outline" className="border-border-strong">
            Sync overdue
          </Badge>
        ) : undefined,
        ariaLabel: `${account.name}, ${institutionName(account)}${stale ? ', sync overdue' : ''}`,
      };
    },
    columns: [
      {
        key: 'name',
        header: 'Account',
        sortable: true,
        width: 'w-[26%]',
        render: (account) => <span className="truncate text-label">{account.name}</span>,
      },
      {
        key: 'institution',
        header: 'Institution',
        width: 'w-[20%]',
        render: (account) => (
          <span className="flex min-w-0 items-center gap-2">
            <InstitutionMark
              name={institutionName(account)}
              website={institutionById.get(account.institutionId)?.website}
              size="size-4"
            />
            <span className="truncate">{institutionName(account)}</span>
          </span>
        ),
        exportValue: (account) => exportText(institutionName(account)),
      },
      {
        key: 'type',
        header: 'Type',
        render: (account) => <span className="truncate">{typeName(account)}</span>,
      },
      {
        key: 'lastSync',
        header: 'Last synced',
        render: (account) => (
          <span className="truncate text-muted-foreground">{lastSyncCell(account)}</span>
        ),
        // The file keeps the sentence: a spreadsheet has no peek to open, and
        // "By hand" in a cell is the abbreviation, not the fact.
        exportValue: (account) => exportText(lastSyncFact(account)),
      },
      {
        key: 'holdings',
        header: 'Holdings',
        sortable: true,
        numeric: true,
        width: 'w-24',
        render: (account) => (
          <Numeric value={account.summary.holdingsCount} format="plain" decimals={0} />
        ),
        exportValue: (account) => exportCount(account.summary.holdingsCount),
      },
      {
        key: 'value',
        header: 'Value',
        sortable: true,
        numeric: true,
        render: (account) => <Numeric value={accountValue(account)} currency={currency} />,
        exportValue: (account) => exportMoney(accountValue(account), currency),
        exportTotal: true,
      },
    ],
    empty: {
      icon: Wallet,
      title: 'No accounts yet',
      description:
        'An account is created for you when you connect an integration or import a statement.',
      // The capture sheet rather than a link — V3-14 made capture shell state
      // so an empty screen can offer it without costing the reader their place.
      action: <Button onClick={openCapture}>Add your first account</Button>,
    },
    peek: {
      basePath: V3_ROUTES.accounts,
      render: (account) => ({
        title: account.name,
        subtitle: institutionName(account),
        leading: (
          <InstitutionMark
            name={institutionName(account)}
            website={institutionById.get(account.institutionId)?.website}
            size="size-8"
          />
        ),
        value: <Numeric value={accountValue(account)} currency={currency} />,
        primary: [
          {
            label: 'Holdings',
            value: <Numeric value={account.summary.holdingsCount} format="plain" decimals={0} />,
          },
          { label: 'Type', value: typeName(account) },
          { label: 'Last synced', value: lastSyncFact(account) },
          {
            label: 'Groups',
            value:
              account.groups.length > 0
                ? account.groups.map((group) => group.name).join(', ')
                : 'None',
          },
        ],
        actions: (
          <Button asChild variant="outline" size="sm">
            <Link to={`${V3_ROUTES.holdings}?account=${encodeURIComponent(account.id)}`}>
              <PieChart className="mr-2 size-4" aria-hidden="true" />
              View holdings
            </Link>
          </Button>
        ),
      }),
    },
    // Same bar, same act, same component as `/holdings` (SC-63). This surface
    // already confirmed — but through a `ConfirmDialog` mounted on the page,
    // which made two list surfaces ask the identical question two different
    // ways. One pattern is the point of having one.
    renderBulkActions: (selectedIds, clearSelection) => (
      <>
        <Button variant="outline" onClick={() => onAssignGroups([...selectedIds], clearSelection)}>
          <Tags className="mr-2 size-4" aria-hidden="true" />
          Assign groups
        </Button>
        <BulkDeleteAction
          count={selectedIds.size}
          noun="accounts"
          isPending={isBulkDeleting}
          consequence={`${selectedNames(accounts, selectedIds)} ${selectedIds.size === 1 ? 'is' : 'are'} removed, and every holding inside ${selectedIds.size === 1 ? 'it' : 'them'} goes too, along with its transaction history. This cannot be undone.`}
          onConfirm={() => onBulkDelete([...selectedIds], clearSelection)}
        />
      </>
    ),
  };

  return <V3DataView config={config} getId={(account) => account.id} query={query} />;
}
