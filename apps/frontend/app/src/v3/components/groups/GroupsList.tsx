import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportCount, exportMoney, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import type { TFunction } from 'i18next';
import { Tags } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  allInactiveGroupAmount,
  compareGroupAmounts,
  type GroupValue,
  groupAmount,
  groupValuesById,
} from '../../lib/groups';
import { type MemberKind, memberCountsLine } from '../../lib/membership';
import { groupDetailPath } from '../../lib/routes';

/**
 * Groups — the user's own labels across holdings and accounts.
 *
 * Rows **navigate** as of SC-70; they used to open a peek. A group's whole
 * substance is its member list, and that list is now editable in place, which
 * is more interaction than a sheet resting at half a phone can hold — the same
 * reasoning that put vaults on a page (V3-15). It also settles a shape the
 * surface could not have both ways: a row that peeked for two counts and would
 * have to navigate to edit is a row that means two things.
 *
 * The `?group=<id>` links into holdings and accounts move to the detail page
 * with everything else, so nothing that was reachable from the peek is lost.
 *
 * **The value column is what the list is ordered on** (SC-87), the treatment
 * SC-61 gave vendor spend. It shipped sorted by holdings count, which ranks a
 * group of forty small positions above the one holding most of the money — so
 * "which of these is the big one" was the question the surface could not
 * answer. A group we could not price sorts last rather than as zero, in either
 * direction: unknown is not small.
 *
 * **A group of only inactive holdings shows what they are worth, muted and
 * badged Inactive** (SC-1128), where it used to show 0 beside a list of rows
 * that each carry a value. That figure is display only: the sort and the
 * export's value column read `amount`, which stays 0. The export marks the row
 * on its name.
 *
 * **The export has no TOTAL row** (SC-1469). A holding in several groups counts
 * in full in each, so the column's sum is not anybody's money.
 */

export interface GroupRow {
  id: string;
  name: string;
  color: string;
  holdingsCount?: number | null;
  accountsCount?: number | null;
  billsCount?: number | null;
  payeesCount?: number | null;
}

interface GroupsListProps {
  groups: GroupRow[];
  /** From `groups.getValues` — empty until it resolves, which renders "—". */
  values: readonly GroupValue[];
  baseCurrency: string;
  query: V3QueryState;
  onCreate: () => void;
}

function holdings(group: GroupRow): number {
  return group.holdingsCount ?? 0;
}

function accounts(group: GroupRow): number {
  return group.accountsCount ?? 0;
}

function bills(group: GroupRow): number {
  return group.billsCount ?? 0;
}

function payees(group: GroupRow): number {
  return group.payeesCount ?? 0;
}

function memberTotal(group: GroupRow): number {
  return holdings(group) + accounts(group) + bills(group) + payees(group);
}

const COUNT_OF: Record<MemberKind, (group: GroupRow) => number> = {
  holding: holdings,
  account: accounts,
  bill: bills,
  payee: payees,
};

/** The group page's own line (`memberCountLine`), from the row's counts. */
function memberLine(group: GroupRow, t: TFunction): string {
  return memberCountsLine((kind) => COUNT_OF[kind](group), t);
}

function ColorMark({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * The list's whole configuration, outside the component so a test can build
 * the export from it exactly as the sheet does (SC-1128).
 */
export function groupsListConfig(
  { groups, values, baseCurrency, onCreate }: Omit<GroupsListProps, 'query'>,
  t: TFunction,
  navigate: (path: string) => void
): V3DataViewConfig<GroupRow> {
  const valueById = groupValuesById(values);
  const amount = (group: GroupRow): number | null => groupAmount(valueById.get(group.id));
  const inactiveAmount = (group: GroupRow): number | null =>
    allInactiveGroupAmount(valueById.get(group.id));
  const inactiveLabel = t('v3.holdings.peek.inactive');
  const figure = (group: GroupRow) => {
    const inactive = inactiveAmount(group);
    if (inactive === null) return <Numeric value={amount(group)} currency={baseCurrency} />;
    return (
      <span className="inline-flex items-center gap-2">
        <Badge variant="secondary" className="shrink-0">
          {inactiveLabel}
        </Badge>
        <span className="text-muted-foreground">
          <Numeric value={inactive} currency={baseCurrency} />
        </span>
      </span>
    );
  };

  return {
    pageKey: 'groups',
    data: groups,
    nounKey: 'ui.dataView.noun.groups',
    searchPlaceholderKey: 'ui.dataView.groups.config.searchGroups',
    searchFn: (group, query) => group.name.toLowerCase().includes(query),
    filterDefs: [
      {
        key: 'members',
        labelKey: 'ui.dataView.groups.filter.members',
        options: [
          { value: 'any', labelKey: 'ui.dataView.groups.option.hasMembers' },
          { value: 'none', labelKey: 'ui.dataView.groups.option.empty' },
        ],
        fn: (group: GroupRow, value) =>
          value === 'none' ? memberTotal(group) === 0 : memberTotal(group) > 0,
      },
    ],
    sortDefs: [
      { key: 'value', labelKey: 'ui.dataView.groups.sort.value' },
      { key: 'holdings', labelKey: 'ui.dataView.groups.sort.holdings' },
      { key: 'accounts', labelKey: 'ui.dataView.groups.sort.accounts' },
      { key: 'name', labelKey: 'ui.dataView.groups.sort.name' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      switch (field) {
        case 'value':
          return compareGroupAmounts(amount(a), amount(b), direction);
        case 'holdings':
          return (holdings(a) - holdings(b)) * mult;
        case 'accounts':
          return (accounts(a) - accounts(b)) * mult;
        default:
          return a.name.localeCompare(b.name) * mult;
      }
    },
    defaultSort: { field: 'value', direction: 'desc' },
    renderRow: (group) => ({
      leading: <ColorMark color={group.color} />,
      label: group.name,
      sublabel: memberLine(group, t),
      value: figure(group),
      ariaLabel: `${group.name}, ${memberLine(group, t)}`,
    }),
    columns: [
      {
        key: 'name',
        headerKey: 'ui.dataView.groups.col.group',
        sortable: true,
        width: 'w-[40%]',
        render: (group) => (
          <span className="flex min-w-0 items-center gap-2">
            <ColorMark color={group.color} />
            <span className="truncate text-label">{group.name}</span>
          </span>
        ),
        exportValue: (group) =>
          exportText(
            inactiveAmount(group) === null ? group.name : `${group.name} · ${inactiveLabel}`
          ),
      },
      {
        key: 'value',
        headerKey: 'ui.dataView.groups.col.value',
        sortable: true,
        numeric: true,
        width: 'w-40',
        render: figure,
        exportValue: (group) => exportMoney(amount(group), baseCurrency),
      },
      {
        key: 'holdings',
        headerKey: 'ui.dataView.groups.col.holdings',
        width: 'w-28',
        sortable: true,
        numeric: true,
        render: (group) => <Numeric value={holdings(group)} format="plain" decimals={0} />,
        exportValue: (group) => exportCount(holdings(group)),
      },
      {
        key: 'accounts',
        headerKey: 'ui.dataView.groups.col.accounts',
        width: 'w-28',
        sortable: true,
        numeric: true,
        render: (group) => <Numeric value={accounts(group)} format="plain" decimals={0} />,
        exportValue: (group) => exportCount(accounts(group)),
      },
      {
        key: 'bills',
        headerKey: 'ui.dataView.groups.col.bills',
        width: 'w-28',
        numeric: true,
        render: (group) => <Numeric value={bills(group)} format="plain" decimals={0} />,
        exportValue: (group) => exportCount(bills(group)),
      },
      {
        key: 'payees',
        headerKey: 'ui.dataView.groups.col.payees',
        width: 'w-28',
        numeric: true,
        render: (group) => <Numeric value={payees(group)} format="plain" decimals={0} />,
        exportValue: (group) => exportCount(payees(group)),
      },
    ],
    empty: {
      icon: Tags,
      titleKey: 'ui.dataView.groups.empty.noGroupsYet',
      descriptionKey: 'ui.dataView.groups.empty.aGroupIsYourOwnLabel',
      action: <Button onClick={onCreate}>{t('v3.groups.createFirst')}</Button>,
    },
    onRowClick: (group) => navigate(groupDetailPath(group.id)),
    rowHref: (group) => groupDetailPath(group.id),
  };
}

export function GroupsList({ query, ...props }: GroupsListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const config = groupsListConfig(props, t, navigate);
  return <V3DataView config={config} getId={(group) => group.id} query={query} />;
}
