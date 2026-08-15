import { formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportDateTime, exportMoney, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Coins, Pencil } from 'lucide-react';
import { amountDecimals } from '../../lib/holdings';
import { V3_ROUTES } from '../../lib/routes';

/**
 * Manually-priced assets — private company shares, anything no pricing provider
 * tracks.
 *
 * The one thing worth knowing about a custom token is *when its price was last
 * touched*, because nothing refreshes it: a stale manual price is a wrong
 * portfolio total that looks exactly like a right one. So the row's delta zone
 * carries the age, and it is the surface's default sort — oldest first, which
 * is the opposite of every other list here and deliberate.
 *
 * These rows are shared across all users, which the empty state says out loud;
 * v2 buries it in a paragraph under the heading.
 */

export interface CustomTokenRow {
  id: string;
  symbol: string;
  name: string;
  typeCode: string | null;
  latestPrice: string | null;
  latestPriceBaseCurrency: string | null;
  latestPriceAt: string | Date | null;
  /** `token_prices.source` for the row above — nullable in the schema. */
  latestPriceSource: string | null;
}

/**
 * Who set the price this token is being valued at.
 *
 * Worth a line of its own on a custom token because the two answers mean
 * opposite things: a manual price is a deliberate mark someone stands behind,
 * and a provider price on a private-company token is a same-symbol match the
 * nightly backfill made because `filterProvidersByTokenType` keeps every
 * provider for types it cannot reason about.
 */
export function priceOrigin(token: CustomTokenRow): string {
  if (!token.latestPriceAt) return 'Nothing recorded';
  const source = token.latestPriceSource;
  if (!source) return 'Unknown source';
  return source.startsWith('manual') ? 'Set manually' : source;
}

interface CustomTokensListProps {
  tokens: CustomTokenRow[];
  query: V3QueryState;
  onCreate: () => void;
  onEditPrice: (token: CustomTokenRow) => void;
}

function typeLabel(token: CustomTokenRow): string {
  return token.typeCode ? token.typeCode.replace(/-/g, ' ') : 'Custom';
}

function priceAge(token: CustomTokenRow): number {
  if (!token.latestPriceAt) return 0;
  const at = new Date(token.latestPriceAt).getTime();
  return Number.isFinite(at) ? at : 0;
}

/**
 * A manual price has no single base currency — each is recorded in whatever the
 * person who set it was thinking in — so the row shows the one it was actually
 * stored in rather than converting to the reader's.
 *
 * Two decimals is the floor, not the rule: a custom token can be a share priced
 * at 128.40 or a unit priced at 0.0000042, and rounding the second to `$0.00`
 * would report a real price as no price. `amountDecimals` (V3-12) asks the
 * number what precision it is carrying.
 */
function TokenPrice({ token }: { token: CustomTokenRow }) {
  return (
    <Numeric
      value={token.latestPrice}
      currency={token.latestPriceBaseCurrency ?? ''}
      decimals={Math.max(2, amountDecimals(Number(token.latestPrice)))}
    />
  );
}

export function CustomTokensList({ tokens, query, onCreate, onEditPrice }: CustomTokensListProps) {
  const typeOptions = [...new Set(tokens.map(typeLabel))]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ value: label, label }));

  const config: V3DataViewConfig<CustomTokenRow> = {
    pageKey: 'tokens:custom',
    data: tokens,
    noun: 'custom tokens',
    nounSingular: 'custom token',
    searchPlaceholder: 'Search custom tokens',
    searchFn: (token, query) =>
      token.symbol.toLowerCase().includes(query) || token.name.toLowerCase().includes(query),
    filterDefs:
      typeOptions.length > 1
        ? [
            {
              key: 'type',
              label: 'Type',
              options: typeOptions,
              fn: (token: CustomTokenRow, value) => typeLabel(token) === value,
            },
          ]
        : [],
    sortDefs: [
      { key: 'priced', label: 'Price updated' },
      { key: 'symbol', label: 'Symbol' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      return field === 'symbol'
        ? a.symbol.localeCompare(b.symbol) * mult
        : (priceAge(a) - priceAge(b)) * mult;
    },
    // Oldest price first: the list exists to find the one that has drifted.
    defaultSort: { field: 'priced', direction: 'asc' },
    groupByDefs: [{ key: 'type', label: 'Type', fn: typeLabel }],
    renderRow: (token) => ({
      label: (
        <span className="flex items-center gap-2">
          {token.symbol}
          <Badge variant="secondary" className="capitalize">
            {typeLabel(token)}
          </Badge>
        </span>
      ),
      sublabel: token.name,
      value: <TokenPrice token={token} />,
      delta: (
        <span className="text-muted-foreground">
          {token.latestPriceAt ? formatRelative(token.latestPriceAt) : 'Never priced'}
        </span>
      ),
      ariaLabel: `${token.symbol}, ${token.name}`,
    }),
    columns: [
      {
        key: 'symbol',
        header: 'Token',
        sortable: true,
        width: 'w-[30%]',
        render: (token) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-label">{token.symbol}</span>
            <span className="truncate text-caption text-muted-foreground">{token.name}</span>
          </span>
        ),
        exportValue: (token) => exportText(token.symbol),
      },
      {
        key: 'type',
        header: 'Type',
        render: (token) => <span className="capitalize">{typeLabel(token)}</span>,
      },
      {
        key: 'price',
        header: 'Price',
        numeric: true,
        render: (token) => <TokenPrice token={token} />,
        exportValue: (token) => exportMoney(token.latestPrice, token.latestPriceBaseCurrency),
      },
      {
        key: 'priced',
        header: 'Price updated',
        sortable: true,
        width: 'w-40',
        render: (token) => (
          <span className="text-muted-foreground">
            {token.latestPriceAt ? formatRelative(token.latestPriceAt) : 'Never'}
          </span>
        ),
        exportValue: (token) => exportDateTime(token.latestPriceAt),
      },
    ],
    empty: {
      icon: Coins,
      title: 'No custom tokens yet',
      description:
        'Create one for an asset no pricing provider tracks — private company shares, a physical holding. The token and its price are shared with every Scani user.',
      action: <Button onClick={onCreate}>New custom token</Button>,
    },
    peek: {
      basePath: V3_ROUTES.tokens,
      render: (token) => ({
        title: token.symbol,
        subtitle: token.name,
        value: <TokenPrice token={token} />,
        primary: [
          { label: 'Type', value: <span className="capitalize">{typeLabel(token)}</span> },
          {
            label: 'Priced in',
            value: token.latestPriceBaseCurrency ?? 'No price recorded',
          },
          {
            label: 'Price updated',
            value: token.latestPriceAt ? formatRelative(token.latestPriceAt) : 'Never',
          },
          { label: 'Price from', value: priceOrigin(token) },
        ],
        actions: (
          <Button size="sm" variant="outline" onClick={() => onEditPrice(token)}>
            <Pencil className="mr-2 size-4" aria-hidden="true" />
            Edit price
          </Button>
        ),
      }),
    },
  };

  return <V3DataView config={config} getId={(token) => token.id} query={query} />;
}
