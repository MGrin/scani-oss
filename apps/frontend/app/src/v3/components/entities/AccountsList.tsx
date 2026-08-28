import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { BulkDeleteAction } from '@scani/ui/v3/components/data-view/BulkDeleteAction';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { nameList, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportCount, exportMoney, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Info, PieChart, Tags, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
  type AccountRow,
  accountLastSync,
  accountsValue,
  accountValue,
  balancesAsOfFact,
  compareAccounts,
  isStaleSync,
  namedAllocation,
} from '../../lib/accounts';
import { formatRelative } from '../../lib/relative-time';
import { accountHoldingsPath, V3_ROUTES } from '../../lib/routes';
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openCapture = useOpenCapture();
  const institutionById = nameById(institutions);
  const typeById = nameById(accountTypes);

  const institutionName = (account: AccountRow) =>
    institutionById.get(account.institutionId)?.name ?? t('v3.entities.account.unknownInstitution');
  const typeName = (account: AccountRow) =>
    typeById.get(account.typeId)?.name ?? t('v3.entities.account.unknownType');

  /**
   * The whole answer — for the peek and for the file, where there is room for
   * a sentence and a reader who has asked about this one account.
   */
  const lastSyncFact = (account: AccountRow) => {
    const lastSync = accountLastSync(account.metadata);
    if (!lastSync) return t('v3.entities.account.neverSynced');
    return isStaleSync(lastSync)
      ? t('v3.entities.account.lastSyncOverdue', { when: formatRelative(t, lastSync) })
      : formatRelative(t, lastSync);
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
    accountLastSync(account.metadata) ? lastSyncFact(account) : t('v3.entities.account.byHand');

  const config: V3DataViewConfig<AccountRow> = {
    pageKey: 'accounts',
    data: accounts,
    nounKey: 'ui.dataView.noun.accounts',
    // Just "Search". This is the one surface here whose toolbar carries three
    // controls — Refine *and* Select — and at 393px "Search accounts" is
    // clipped by the input's own edge to "Search account", which reads as a
    // different, wrong word. The `aria-label` `V3DataView` derives from `noun`
    // still says "Search accounts", so nothing is lost to a screen reader.
    searchPlaceholderKey: 'ui.dataView.accounts.config.search',
    defaultFilters,
    searchFn: (account, query) =>
      account.name.toLowerCase().includes(query) ||
      institutionName(account).toLowerCase().includes(query),
    filterDefs: [
      {
        key: 'institution',
        labelKey: 'ui.dataView.accounts.filter.institution',
        options: referencedOptions(
          institutionById,
          accounts.map((account) => account.institutionId)
        ),
        fn: (account: AccountRow, value) => account.institutionId === value,
      },
      {
        key: 'type',
        labelKey: 'ui.dataView.accounts.filter.type',
        options: referencedOptions(
          typeById,
          accounts.map((account) => account.typeId)
        ),
        fn: (account: AccountRow, value) => account.typeId === value,
      },
      {
        key: 'group',
        labelKey: 'ui.dataView.accounts.filter.group',
        options: (groups ?? []).map((group) => ({ value: group.id, label: group.name })),
        fn: (account: AccountRow, value) => account.groups.some((group) => group.id === value),
      },
      {
        key: 'contents',
        labelKey: 'ui.dataView.accounts.filter.contents',
        options: [
          { value: 'holding', labelKey: 'ui.dataView.accounts.option.holdsSomething' },
          { value: 'empty', labelKey: 'ui.dataView.accounts.option.empty' },
        ],
        fn: (account: AccountRow, value) =>
          value === 'empty'
            ? account.summary.holdingsCount === 0
            : account.summary.holdingsCount > 0,
      },
    ],
    sortDefs: [
      { key: 'value', labelKey: 'ui.dataView.accounts.sort.value' },
      { key: 'name', labelKey: 'ui.dataView.accounts.sort.name' },
      { key: 'holdings', labelKey: 'ui.dataView.accounts.sort.holdings' },
    ],
    sortFn: compareAccounts,
    defaultSort: { field: 'value', direction: 'desc' },
    groupByDefs: [
      {
        key: 'institution',
        labelKey: 'ui.dataView.accounts.group.institution',
        fn: institutionName,
      },
      { key: 'type', labelKey: 'ui.dataView.accounts.group.type', fn: typeName },
    ],
    summary: (items) => (
      <EntityValueSummary
        value={accountsValue(items)}
        currency={currency}
        allocation={namedAllocation(items, accountValue)}
        allocationLabel={t('v3.entities.account.valueByAccount')}
      />
    ),
    renderRow: (account) => {
      const stale = isStaleSync(accountLastSync(account.metadata));
      return {
        leading: (
          <InstitutionMark
            name={institutionName(account)}
            institution={institutionById.get(account.institutionId)}
            size="size-5"
          />
        ),
        label: account.name,
        // `count` first, before an argument that carries a `)`.
        // `i18n-keys.test.ts` reads a wrapped `t()` call across three lines and
        // stops at the first `)`, so `institution: institutionName(account)`
        // ahead of the count hides it and the key reads as missing.
        sublabel: t('v3.entities.account.sublabel', {
          count: account.summary.holdingsCount,
          institution: institutionName(account),
        }),
        value: <Numeric value={accountValue(account)} currency={currency} />,
        // The badge goes in the delta zone, not next to the name. The identity
        // zone truncates — that is its job — and "Ledger Nano — cold storage"
        // is long enough on a 393px row to clip the badge down to the left
        // edge of its own border, which renders as a stray arc that says
        // nothing. The value zone never truncates, which is exactly what a
        // warning needs.
        delta: stale ? (
          <Badge variant="outline" className="border-border-strong">
            {t('v3.entities.account.syncOverdue')}
          </Badge>
        ) : undefined,
        // A comma-joined ENUMERATION of three independent facts, not a
        // sentence — so the separator is markup and each fact is the same
        // whole key the badge above uses (SC-235). It was `", sync overdue"`,
        // a key carrying the comma that attached it to the name before it.
        ariaLabel: [
          account.name,
          institutionName(account),
          stale ? t('v3.entities.account.syncOverdue') : null,
        ]
          .filter(Boolean)
          .join(', '),
      };
    },
    columns: [
      {
        key: 'name',
        headerKey: 'ui.dataView.accounts.col.account',
        sortable: true,
        width: 'w-[26%]',
        render: (account) => <span className="truncate text-label">{account.name}</span>,
      },
      {
        key: 'institution',
        headerKey: 'ui.dataView.accounts.col.institution',
        width: 'w-[20%]',
        render: (account) => (
          <span className="flex min-w-0 items-center gap-2">
            <InstitutionMark
              name={institutionName(account)}
              institution={institutionById.get(account.institutionId)}
              size="size-4"
            />
            <span className="truncate">{institutionName(account)}</span>
          </span>
        ),
        exportValue: (account) => exportText(institutionName(account)),
      },
      {
        key: 'type',
        headerKey: 'ui.dataView.accounts.col.type',
        render: (account) => <span className="truncate">{typeName(account)}</span>,
      },
      {
        key: 'lastSync',
        headerKey: 'ui.dataView.accounts.col.lastSynced',
        render: (account) => (
          <span className="truncate text-muted-foreground">{lastSyncCell(account)}</span>
        ),
        // The file keeps the sentence: a spreadsheet has no peek to open, and
        // "By hand" in a cell is the abbreviation, not the fact.
        exportValue: (account) => exportText(lastSyncFact(account)),
      },
      {
        key: 'holdings',
        headerKey: 'ui.dataView.accounts.col.holdings',
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
        headerKey: 'ui.dataView.accounts.col.value',
        sortable: true,
        numeric: true,
        render: (account) => <Numeric value={accountValue(account)} currency={currency} />,
        exportValue: (account) => exportMoney(accountValue(account), currency),
        exportTotal: true,
      },
    ],
    empty: {
      icon: Wallet,
      titleKey: 'ui.dataView.accounts.empty.noAccountsYet',
      descriptionKey: 'ui.dataView.accounts.empty.anAccountIsCreatedForYou',
      // The capture sheet rather than a link — V3-14 made capture shell state
      // so an empty screen can offer it without costing the reader their place.
      action: <Button onClick={openCapture}>{t('v3.entities.account.addFirst')}</Button>,
    },
    /**
     * Where an account row leads now (SC-560).
     *
     * It was already the peek's first action; what changed is that it is the
     * ROW. "Show me what is in this account" is what a reader means by tapping
     * an account nine times in ten, and it used to cost them two taps behind
     * the one time in ten they wanted the account's own record.
     */
    onRowClick: (account) => navigate(accountHoldingsPath(account.id)),
    rowHref: (account) => accountHoldingsPath(account.id),
    /**
     * The account's own record, one control over rather than on the row
     * (SC-560).
     *
     * The five facts below are not what a reader is after when they tap an
     * account, and the sheet was standing between them and the answer. They
     * are still worth reaching — `balancesAsOf` in particular is stated
     * nowhere else in the product — so the sheet keeps its URL, its content
     * and its actions, and loses only its claim on the row.
     */
    peekTrigger: { icon: Info, labelKey: 'ui.dataView.accounts.config.details' },
    peek: {
      basePath: V3_ROUTES.accounts,
      render: (account) => {
        const asOfFact = balancesAsOfFact(account.metadata);
        return {
          title: account.name,
          subtitle: institutionName(account),
          leading: (
            <InstitutionMark
              name={institutionName(account)}
              institution={institutionById.get(account.institutionId)}
              size="size-8"
            />
          ),
          value: <Numeric value={accountValue(account)} currency={currency} />,
          primary: [
            {
              label: t('v3.entities.account.holdings'),
              value: <Numeric value={account.summary.holdingsCount} format="plain" decimals={0} />,
            },
            { label: t('v3.entities.account.type'), value: typeName(account) },
            { label: t('v3.entities.account.lastSynced'), value: lastSyncFact(account) },
            // SC-384's whole point, and the only fact here that is sometimes
            // absent. "Last synced: just now" was true and answered a question
            // nobody asked — the request was minutes ago, the IBKR positions in
            // it were the previous business day's close, and a reader who had
            // just traded took the fresh timestamp as a claim about the numbers
            // under it. Omitted entirely for a live-balance account, which is
            // all of them but one: twenty rows saying "as of now" would train
            // the eye past the row where this means something.
            ...(asOfFact
              ? [{ label: t('v3.entities.account.balancesAsOf'), value: asOfFact }]
              : []),
            {
              label: t('v3.entities.account.groups'),
              value:
                account.groups.length > 0
                  ? account.groups.map((group) => group.name).join(', ')
                  : 'None',
            },
          ],
          // The row is this link now (SC-560), so the sheet keeps it only for
          // the reader who arrived at the sheet directly — a shared
          // `/accounts/<id>`, or the back gesture landing on one. Removing it
          // would leave that reader with no way into the account's holdings
          // at all.
          actions: (
            <Button asChild variant="outline" size="sm">
              <Link to={accountHoldingsPath(account.id)}>
                <PieChart className="me-2 size-4" aria-hidden="true" />
                {t('v3.entities.account.viewHoldings')}
              </Link>
            </Button>
          ),
        };
      },
    },
    // Same bar, same act, same component as `/holdings` (SC-63). This surface
    // already confirmed — but through a `ConfirmDialog` mounted on the page,
    // which made two list surfaces ask the identical question two different
    // ways. One pattern is the point of having one.
    renderBulkActions: (selectedIds, clearSelection) => (
      <>
        <Button variant="outline" onClick={() => onAssignGroups([...selectedIds], clearSelection)}>
          <Tags className="me-2 size-4" aria-hidden="true" />
          {t('v3.entities.account.assignGroups')}
        </Button>
        <BulkDeleteAction
          count={selectedIds.size}
          nounKey="ui.dataView.noun.accounts"
          isPending={isBulkDeleting}
          consequence={t('v3.entities.account.bulkDeleteConsequence', {
            count: selectedIds.size,
            names: selectedNames(accounts, selectedIds),
          })}
          onConfirm={() => onBulkDelete([...selectedIds], clearSelection)}
        />
      </>
    ),
  };

  return <V3DataView config={config} getId={(account) => account.id} query={query} />;
}
