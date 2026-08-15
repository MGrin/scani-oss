import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportCount, exportMoney } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Building2, PieChart } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  compareInstitutions,
  type InstitutionRow,
  institutionsValue,
  institutionValue,
  namedAllocation,
} from '../../lib/accounts';
import { V3_ROUTES } from '../../lib/routes';
import { useOpenCapture } from '../capture/CaptureSheetContext';
import { EntityValueSummary } from './EntityValueSummary';
import { InstitutionMark } from './InstitutionMark';

/**
 * Where the portfolio is held — the same shape as `AccountsList` one level up.
 *
 * An institution has no editable state in this app: it is a name, a website and
 * the sum of what sits behind it. That is a peek exactly, and the one thing a
 * reader wants from it is the way through to the positions, so the sheet's only
 * action is the filtered holdings link.
 */

interface InstitutionsListProps {
  institutions: InstitutionRow[];
  currency: string;
  types: readonly { id: string; name: string }[] | undefined;
  query: V3QueryState;
}

export function InstitutionsList({ institutions, currency, types, query }: InstitutionsListProps) {
  const openCapture = useOpenCapture();
  const typeById = new Map((types ?? []).map((type) => [type.id, type.name]));
  const typeName = (institution: InstitutionRow) =>
    typeById.get(institution.typeId) ?? 'Unknown type';

  const accountCount = (institution: InstitutionRow) => institution.summary?.accountCount ?? 0;

  // Only the types actually present. `institutionTypes.getAll` is a global
  // catalogue, and offering "Pension fund" to someone with two crypto exchanges
  // is a filter whose only outcome is the empty screen.
  const presentTypeIds = new Set(institutions.map((institution) => institution.typeId));
  const typeOptions = [...presentTypeIds]
    .map((id) => ({ value: id, label: typeById.get(id) ?? id }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const config: V3DataViewConfig<InstitutionRow> = {
    pageKey: 'institutions',
    data: institutions,
    noun: 'institutions',
    searchPlaceholder: 'Search institutions',
    searchFn: (institution, query) =>
      institution.name.toLowerCase().includes(query) ||
      (institution.description ?? '').toLowerCase().includes(query),
    filterDefs:
      typeOptions.length > 1
        ? [
            {
              key: 'type',
              label: 'Type',
              options: typeOptions,
              fn: (institution: InstitutionRow, value) => institution.typeId === value,
            },
          ]
        : [],
    sortDefs: [
      { key: 'value', label: 'Value' },
      { key: 'name', label: 'Name' },
      { key: 'accounts', label: 'Accounts' },
    ],
    sortFn: compareInstitutions,
    defaultSort: { field: 'value', direction: 'desc' },
    groupByDefs: [{ key: 'type', label: 'Type', fn: typeName }],
    summary: (items) => (
      <EntityValueSummary
        value={institutionsValue(items)}
        currency={currency}
        allocation={namedAllocation(items, institutionValue)}
        allocationLabel="Value by institution"
      />
    ),
    renderRow: (institution) => ({
      leading: (
        <InstitutionMark name={institution.name} website={institution.website} size="size-5" />
      ),
      label: institution.name,
      sublabel: `${accountCount(institution)} ${accountCount(institution) === 1 ? 'account' : 'accounts'}`,
      value: <Numeric value={institutionValue(institution)} currency={currency} />,
    }),
    columns: [
      {
        key: 'name',
        header: 'Institution',
        sortable: true,
        width: 'w-[40%]',
        render: (institution) => (
          <span className="flex min-w-0 items-center gap-2">
            <InstitutionMark name={institution.name} website={institution.website} size="size-4" />
            <span className="truncate text-label">{institution.name}</span>
          </span>
        ),
      },
      {
        key: 'type',
        header: 'Type',
        render: (institution) => <span className="truncate">{typeName(institution)}</span>,
      },
      {
        key: 'accounts',
        header: 'Accounts',
        sortable: true,
        numeric: true,
        width: 'w-28',
        render: (institution) => (
          <Numeric value={accountCount(institution)} format="plain" decimals={0} />
        ),
        exportValue: (institution) => exportCount(accountCount(institution)),
      },
      {
        key: 'value',
        header: 'Value',
        sortable: true,
        numeric: true,
        render: (institution) => (
          <Numeric value={institutionValue(institution)} currency={currency} />
        ),
        exportValue: (institution) => exportMoney(institutionValue(institution), currency),
        exportTotal: true,
      },
    ],
    empty: {
      icon: Building2,
      title: 'No institutions yet',
      description:
        'An institution appears here the first time an import or an integration brings an account in from it.',
      // The capture sheet rather than a link — see `AccountsList`.
      action: <Button onClick={openCapture}>Connect one</Button>,
    },
    peek: {
      basePath: V3_ROUTES.institutions,
      render: (institution) => ({
        title: institution.name,
        subtitle: typeName(institution),
        leading: (
          <InstitutionMark name={institution.name} website={institution.website} size="size-8" />
        ),
        value: <Numeric value={institutionValue(institution)} currency={currency} />,
        primary: [
          {
            label: 'Accounts',
            value: <Numeric value={accountCount(institution)} format="plain" decimals={0} />,
          },
          { label: 'Type', value: typeName(institution) },
          { label: 'Website', value: institution.website ?? 'None on file' },
          ...(institution.description
            ? [{ label: 'Description', value: institution.description }]
            : []),
        ],
        actions: (
          <>
            <Button asChild variant="outline" size="sm">
              <Link to={`${V3_ROUTES.holdings}?institution=${encodeURIComponent(institution.id)}`}>
                <PieChart className="mr-2 size-4" aria-hidden="true" />
                View holdings
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={`${V3_ROUTES.accounts}?institution=${encodeURIComponent(institution.id)}`}>
                View accounts
              </Link>
            </Button>
          </>
        ),
      }),
    },
  };

  return <V3DataView config={config} getId={(institution) => institution.id} query={query} />;
}
