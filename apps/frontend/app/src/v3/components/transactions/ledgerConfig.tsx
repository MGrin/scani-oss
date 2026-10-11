import { accountLabel, balanceDecimals, formatDate } from '@scani/shared';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig, V3FilterDef } from '@scani/ui/v3/lib/data-view';
import { exportDateTime, exportNumber, exportText } from '@scani/ui/v3/lib/export/cell';
import i18n, { type TFunction } from 'i18next';
import { ReceiptText, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { V3_ROUTES } from '../../lib/routes';
import { CategoryChip } from '../categories/CategoryChip';
import type { CategoryNodeView } from '../categories/CategoryPicker';
import { DateField, localDateFromIso } from '../form/DateField';
import { PayeeMark } from '../money/PayeeMark';

/** What `/transactions` asks the server for (SC-1652). */
export interface LedgerFilters {
  /** A category id, `uncategorized`, or `auto` for the ones a rule or AI set (SC-1695). */
  category?: string;
  accountId?: string;
  holdingId?: string;
  periodDays?: number;
  /** A custom range's ends, `YYYY-MM-DD`, inclusive; either may be open. */
  fromDay?: string;
  toDay?: string;
}

/** No colon, so each filter's URL parameter is its bare key: `?category=`, `?account=`, `?holding=`. */
export const LEDGER_PAGE_KEY = 'transactions';

const PERIODS = ['30', '90', '365'] as const;
const PERIOD_LABELS = {
  '30': 'ui.dataView.bills.period.last30',
  '90': 'ui.dataView.bills.period.last90',
  '365': 'ui.dataView.bills.period.last365',
} as const;

/** `2025-04-06..2026-04-05`, either end optional but not both. */
const RANGE = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/;

function parseRange(value: string): { fromDay?: string; toDay?: string } | null {
  const match = RANGE.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  return { fromDay: match[1], toDay: match[2] };
}

function formatDay(day: string | undefined): string {
  const date = day ? localDateFromIso(day) : null;
  return date ? formatDate(date) : '';
}

/** The custom range's editor: the shared date field, twice, inside the Refine sheet. */
export function LedgerRangeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const range = parseRange(value) ?? {};
  // The latest ends, not the ones this render saw: the URL round-trip that
  // carries the first date back as `value` can land after the second date is
  // entered, and building on `range` then dropped the first (seen in the browser).
  const latest = useRef(range);
  useEffect(() => {
    latest.current = parseRange(value) ?? {};
  }, [value]);
  const set = (patch: { fromDay?: string; toDay?: string }) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    onChange(next.fromDay || next.toDay ? `${next.fromDay ?? ''}..${next.toDay ?? ''}` : '');
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="ledger-range-from" className="text-caption text-muted-foreground">
          {t('v3.transactions.range.from')}
        </label>
        <DateField
          id="ledger-range-from"
          value={range.fromDay ?? ''}
          clearable
          onChange={(day) => set({ fromDay: day || undefined })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="ledger-range-to" className="text-caption text-muted-foreground">
          {t('v3.transactions.range.to')}
        </label>
        <DateField
          id="ledger-range-to"
          value={range.toDay ?? ''}
          clearable
          onChange={(day) => set({ toDay: day || undefined })}
        />
      </div>
    </div>
  );
}

/** Every row the server sent already matches: the filters ran there, not here. */
const SERVER_APPLIED = () => true;

/**
 * The ledger's filters as Bills declares its own, so `/transactions` gets the
 * same search field, sliders button, filter sheet and chips (SC-1652).
 */
export function ledgerFilterDefs({
  nodes,
  accounts,
  holdings,
}: {
  nodes: readonly CategoryNodeView[];
  accounts: readonly { id: string; name: string }[];
  holdings: readonly { id: string; label: string }[];
}): V3FilterDef[] {
  return [
    {
      key: 'category',
      labelKey: 'ui.dataView.transactions.filter.category',
      options: [
        { value: 'uncategorized', label: i18n.t('v3.categories.uncategorized') },
        { value: 'auto', label: i18n.t('v3.categories.auto.marker') },
        ...nodes.flatMap((parent) => [
          { value: parent.id, label: parent.name },
          ...parent.children.map((child) => ({
            value: child.id,
            label: `${parent.name} › ${child.name}`,
          })),
        ]),
      ],
      fn: SERVER_APPLIED,
    },
    {
      key: 'account',
      labelKey: 'ui.dataView.transactions.filter.account',
      options: accounts.map((account) => ({ value: account.id, label: account.name })),
      fn: SERVER_APPLIED,
    },
    {
      key: 'holding',
      labelKey: 'ui.dataView.transactions.filter.holding',
      options: holdings.map((holding) => ({ value: holding.id, label: holding.label })),
      fn: SERVER_APPLIED,
    },
    {
      key: 'period',
      labelKey: 'ui.dataView.transactions.filter.period',
      anyLabelKey: 'ui.dataView.transactions.period.all',
      options: PERIODS.map((value) => ({ value, labelKey: PERIOD_LABELS[value] })),
      custom: {
        labelKey: 'ui.dataView.transactions.period.custom',
        matches: (value) => parseRange(value) !== null,
        format: (value) => {
          const range = parseRange(value) ?? {};
          return `${formatDay(range.fromDay)} – ${formatDay(range.toDay)}`.trim();
        },
        render: (value, onChange) => <LedgerRangeEditor value={value} onChange={onChange} />,
      },
      fn: SERVER_APPLIED,
    },
  ];
}

export function ledgerFiltersFromView(values: Record<string, string>): LedgerFilters {
  const out: LedgerFilters = {};
  if (values.category) out.category = values.category;
  if (values.account) out.accountId = values.account;
  if (values.holding) out.holdingId = values.holding;
  if ((PERIODS as readonly string[]).includes(values.period ?? '')) {
    out.periodDays = Number(values.period);
  }
  const range = parseRange(values.period ?? '');
  if (range?.fromDay) out.fromDay = range.fromDay;
  if (range?.toDay) out.toDay = range.toDay;
  return out;
}

const LEDGER_PAGE_SIZE = 50;

/** The filters as `transactions.list` takes them; a period starts at the person's local midnight. */
export function ledgerListInput(filters: LedgerFilters, cursor: number, now: Date = new Date()) {
  let from: Date | undefined;
  let to: Date | undefined;
  if (filters.periodDays) {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - filters.periodDays);
  }
  if (filters.fromDay) from = localDateFromIso(filters.fromDay) ?? undefined;
  if (filters.toDay) {
    const last = localDateFromIso(filters.toDay);
    if (last) to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1, 0, 0, 0, -1);
  }
  const category = filters.category;
  return {
    category: !category
      ? undefined
      : category === 'uncategorized'
        ? ('uncategorized' as const)
        : category === 'auto'
          ? ('auto' as const)
          : { id: category },
    accountId: filters.accountId,
    holdingId: filters.holdingId,
    from,
    to,
    limit: LEDGER_PAGE_SIZE,
    cursor,
  };
}

export interface LedgerRow {
  id: string;
  occurredAt: Date;
  label: string;
  accountName: string | null;
  quantity: string;
  symbol: string;
  tokenTypeCode: string | null;
  categoryId: string | null;
  categoryPath: string | null;
  categoryColor: string | null;
  /** Who set the category: a person, an import, a rule or AI (SC-1695). */
  categorySetBy: string | null;
  /** Who the row is with, as a rule matches it. */
  payee: string | null;
}

/** A guess, not a choice: a rule or AI set it (SC-1695). */
function isAutoCategory(row: Pick<LedgerRow, 'categorySetBy'>): boolean {
  return row.categorySetBy === 'rule' || row.categorySetBy === 'ai';
}

interface LedgerSource {
  id: string;
  occurredAt: Date | string;
  description: string | null;
  counterparty: string | null;
  quantity: string;
  holdingId: string;
  categoryId: string | null;
  categorySetBy: string | null;
}

interface LedgerHolding {
  id: string;
  account: { name: string };
  institution: { name: string };
  token: { symbol: string; typeCode: string | null };
}

function findCategory(
  nodes: readonly CategoryNodeView[],
  id: string
): { path: string; color: string | null } | null {
  for (const parent of nodes) {
    if (parent.id === id) return { path: parent.name, color: parent.color };
    const child = parent.children.find((node) => node.id === id);
    if (child)
      return { path: `${parent.name} › ${child.name}`, color: child.color ?? parent.color };
  }
  return null;
}

export function toLedgerRows<T extends LedgerSource>(
  transactions: readonly T[],
  holdings: readonly LedgerHolding[],
  categories: readonly CategoryNodeView[],
  fallbackLabel: (row: T) => string
): LedgerRow[] {
  const holdingById = new Map(holdings.map((holding) => [holding.id, holding]));
  return transactions.map((row) => {
    const holding = holdingById.get(row.holdingId);
    const category = row.categoryId ? findCategory(categories, row.categoryId) : null;
    return {
      id: row.id,
      occurredAt: new Date(row.occurredAt),
      label: row.description?.trim() || row.counterparty?.trim() || fallbackLabel(row),
      accountName: holding ? accountLabel(holding.account.name, holding.institution.name) : null,
      quantity: row.quantity,
      symbol: holding?.token.symbol ?? '',
      tokenTypeCode: holding?.token.typeCode ?? null,
      categoryId: row.categoryId,
      categoryPath: category?.path ?? null,
      categoryColor: category?.color ?? null,
      categorySetBy: row.categorySetBy,
      payee: row.counterparty?.trim() || row.description?.trim() || null,
    };
  });
}

export function ledgerAccountOptions(
  accounts: readonly { id: string; name: string }[],
  holdings: readonly { account: { id: string; name: string }; institution: { name: string } }[]
): { id: string; name: string }[] {
  const labels = new Map(
    holdings.map((holding) => [
      holding.account.id,
      accountLabel(holding.account.name, holding.institution.name),
    ])
  );
  return accounts.map((account) => ({
    id: account.id,
    name: labels.get(account.id) ?? account.name,
  }));
}

/** A holding named by its token and its account, so the filter chip reads like the row. */
export function ledgerHoldingOptions(
  holdings: readonly LedgerHolding[]
): { id: string; label: string }[] {
  return holdings.map((holding) => ({
    id: holding.id,
    label: `${holding.token.symbol} · ${accountLabel(holding.account.name, holding.institution.name)}`,
  }));
}

/** The phone row's second line. The category comes before the account, so a
 * truncated line on a 390px screen loses the account rather than the category. */
export function ledgerSublabel(
  row: Pick<LedgerRow, 'occurredAt' | 'accountName' | 'categoryPath'>
): string {
  return [formatDate(row.occurredAt), row.categoryPath, row.accountName]
    .filter(Boolean)
    .join(' · ');
}

export function CategoryCell({
  path,
  color,
  auto = false,
}: {
  path: string | null;
  color: string | null;
  auto?: boolean;
}) {
  const { t } = useTranslation();
  if (!path) {
    return (
      <span className="text-label text-muted-foreground">{t('v3.categories.uncategorized')}</span>
    );
  }
  return <CategoryChip name={path} color={color} auto={auto} />;
}

/**
 * The phone row's second line, led by the marker when a rule or AI set the
 * category. Leading, because the line truncates and a trailing marker was cut.
 */
function LedgerSublabel({ row }: { row: LedgerRow }) {
  const { t } = useTranslation();
  if (!isAutoCategory(row)) return <>{ledgerSublabel(row)}</>;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Sparkles
        role="img"
        aria-label={t('v3.categories.auto.marker')}
        className="size-3 shrink-0 text-muted-foreground"
      />
      <span className="truncate">{ledgerSublabel(row)}</span>
    </span>
  );
}

/**
 * What a pick says when it lands (SC-1695). A spread goes on the toast's
 * second line, so no language has to join two sentences into one.
 */
export function setCategoryMessage(
  t: TFunction,
  { updated, spread }: { updated: number; spread: number },
  name: string | null
): { message: string; context?: string } {
  const moved = name
    ? t('v3.transactions.moved', { count: updated, name })
    : t('v3.transactions.cleared', { count: updated });
  return spread > 0
    ? { context: moved, message: t('v3.categories.auto.spread', { count: spread }) }
    : { message: moved };
}

function Amount({ row }: { row: LedgerRow }) {
  // Bills' form for money: the currency's own symbol. A token has none, so it keeps its code.
  if (row.tokenTypeCode === 'fiat') {
    return <Numeric value={row.quantity} currency={row.symbol} delta indicator="sign" />;
  }
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <Numeric
        value={row.quantity}
        format="plain"
        decimals={balanceDecimals(row.quantity, row.tokenTypeCode)}
        delta
        indicator="sign"
      />
      <span className="text-caption text-muted-foreground">{row.symbol}</span>
    </span>
  );
}

export function ledgerConfig({
  rows,
  filterDefs,
  onSearch,
  peek,
  bulkActions,
  emptyAction,
}: {
  rows: LedgerRow[];
  /** From `ledgerFilterDefs`; applied by the server, which the page asks with them. */
  filterDefs: V3FilterDef[];
  /** Searches the server: a search over the loaded page would miss the rest (SC-244). */
  onSearch: (term: string) => void;
  emptyAction: ReactNode;
  peek: (row: LedgerRow) => ReactNode;
  bulkActions: (selectedIds: Set<string>, clearSelection: () => void) => ReactNode;
}): V3DataViewConfig<LedgerRow> {
  return {
    pageKey: LEDGER_PAGE_KEY,
    data: rows,
    nounKey: 'ui.dataView.noun.transactions',
    onSearch,
    filterDefs,
    filtersAreRemote: true,
    renderRow: (row) => ({
      leading: <PayeeMark name={row.label} />,
      label: row.label,
      sublabel: <LedgerSublabel row={row} />,
      value: <Amount row={row} />,
      ariaLabel: [
        row.label,
        formatDate(row.occurredAt),
        row.categoryPath,
        row.accountName,
        `${row.quantity} ${row.symbol}`,
      ]
        .filter(Boolean)
        .join(', '),
    }),
    columns: [
      {
        key: 'date',
        headerKey: 'ui.dataView.transactions.col.date',
        width: 'w-32',
        render: (row) => (
          <span className="text-muted-foreground">{formatDate(row.occurredAt)}</span>
        ),
        exportValue: (row) => exportDateTime(row.occurredAt),
      },
      {
        key: 'description',
        headerKey: 'ui.dataView.transactions.col.description',
        width: 'w-[32%]',
        render: (row) => <span className="truncate text-label">{row.label}</span>,
        exportValue: (row) => exportText(row.label),
      },
      {
        key: 'account',
        headerKey: 'ui.dataView.transactions.col.account',
        width: 'w-40',
        hideBelow: 'xl',
        render: (row) => <span className="truncate text-muted-foreground">{row.accountName}</span>,
        exportValue: (row) => exportText(row.accountName),
      },
      {
        key: 'category',
        headerKey: 'ui.dataView.transactions.col.category',
        width: 'w-48',
        render: (row) => (
          <CategoryCell
            path={row.categoryPath}
            color={row.categoryColor}
            auto={isAutoCategory(row)}
          />
        ),
        exportValue: (row) => exportText(row.categoryPath),
      },
      {
        key: 'amount',
        headerKey: 'ui.dataView.transactions.col.amount',
        numeric: true,
        width: 'w-40',
        render: (row) => <Amount row={row} />,
        exportValue: (row) => exportNumber(row.quantity),
      },
    ],
    empty: {
      icon: ReceiptText,
      titleKey: 'ui.dataView.transactions.empty.title',
      descriptionKey: 'ui.dataView.transactions.empty.description',
      action: emptyAction,
    },
    peek: {
      basePath: V3_ROUTES.transactions,
      render: (row) => ({
        title: row.label,
        subtitle: [formatDate(row.occurredAt), row.accountName].filter(Boolean).join(' · '),
        value: <Amount row={row} />,
        primary: [],
        content: peek(row),
      }),
    },
    renderBulkActions: (selectedIds, clearSelection) => bulkActions(selectedIds, clearSelection),
  };
}
