import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Plug } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { RouterOutputs } from '@/lib/trpc';
import { integrationCategoryLabel } from '../../lib/capture-forms';
import { integrationConnectPath, V3_CAPTURE_ROUTES } from '../../lib/routes';
import { InstitutionMark } from '../entities/InstitutionMark';

export type Integration = RouterOutputs['integrations']['listAvailable'][number];

/**
 * Every exchange, bank and broker Scani can hold read-only keys for.
 *
 * A `V3DataView` rather than the four hard-coded category sections v2 renders,
 * and the difference is not the styling. v2 lists four `typeCodes` groups and
 * draws **only** providers whose institution type matches one of them, so a
 * provider seeded with any other type is silently absent from the one screen
 * that can connect it. Here the category is a filter over a list that always
 * shows everything, and an unrecognised code lands in "Other" — visible, and
 * connectable.
 *
 * Search is the other thing the grid could not do. The list is short enough
 * today to scan, and the moment it is not, scanning a two-column grid of
 * favicons for "the one whose name I half remember" is the worst possible way
 * to find it.
 */
export function IntegrationsList({
  integrations,
  query,
}: {
  integrations: Integration[];
  query: V3QueryState;
}) {
  const navigate = useNavigate();

  const category = (integration: Integration) =>
    integrationCategoryLabel(integration.institution.type?.code);

  const config: V3DataViewConfig<Integration> = {
    pageKey: 'integrations',
    data: integrations,
    noun: 'integrations',
    nounSingular: 'integration',
    searchPlaceholder: 'Search',
    searchFn: (integration, term) =>
      integration.institution.name.toLowerCase().includes(term) ||
      (integration.institution.description ?? '').toLowerCase().includes(term),
    filterDefs: [
      {
        key: 'category',
        label: 'Kind',
        options: [...new Set(integrations.map(category))]
          .sort((a, b) => a.localeCompare(b))
          .map((label) => ({ value: label, label })),
        fn: (integration: Integration, value) => category(integration) === value,
      },
    ],
    sortDefs: [{ key: 'name', label: 'Name' }],
    sortFn: (a, b) => a.institution.name.localeCompare(b.institution.name),
    defaultSort: { field: 'name', direction: 'asc' },
    groupByDefs: [{ key: 'category', label: 'Kind', fn: category }],
    renderRow: (integration) => ({
      leading: (
        <InstitutionMark
          name={integration.institution.name}
          website={integration.institution.website}
          size="size-5"
        />
      ),
      label: integration.institution.name,
      sublabel: integration.institution.description ?? category(integration),
      // The kind, not a figure: this is the one v3 list whose rows have no
      // value of their own — nothing is connected yet, which is the point of
      // being here.
      value: <span className="text-caption text-muted-foreground">{category(integration)}</span>,
    }),
    columns: [
      {
        key: 'name',
        header: 'Service',
        sortable: true,
        render: (integration) => (
          <span className="flex min-w-0 items-center gap-2">
            <InstitutionMark
              name={integration.institution.name}
              website={integration.institution.website}
              size="size-5"
            />
            <span className="truncate">{integration.institution.name}</span>
          </span>
        ),
      },
      { key: 'category', header: 'Kind', render: category, width: 'w-40' },
      {
        key: 'description',
        header: 'What it syncs',
        render: (integration) => (
          <span className="text-muted-foreground">
            {integration.institution.description ?? '—'}
          </span>
        ),
      },
    ],
    empty: {
      icon: Plug,
      title: 'No services to connect',
      description:
        'Scani ships its integrations with the app, so an empty list means the catalogue failed to load rather than that there are none to have.',
      action: (
        <Button asChild>
          <Link to={V3_CAPTURE_ROUTES.fileImport}>Upload a statement instead</Link>
        </Button>
      ),
    },
    onRowClick: (integration) => navigate(integrationConnectPath(integration.providerKey)),
    // The same destination as a URL, so the row is a link the browser can
    // open in a second tab rather than a handler that moves this one (SC-118).
    rowHref: (integration) => integrationConnectPath(integration.providerKey),
  };

  return (
    <V3DataView config={config} getId={(integration) => integration.providerKey} query={query} />
  );
}
