import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportNumber, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { EyeOff, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { amountDecimals } from '../../lib/holdings';
import { V3_ROUTES } from '../../lib/routes';
import {
  type HiddenHoldingRow,
  hiddenReasonLabel,
  isScamFlagged,
  TOKENS_HIDDEN_PATH,
} from '../../lib/tokens';
import { HiddenHoldingActions } from './HiddenHoldingActions';

/**
 * The unit count, at the precision it actually carries. `amountDecimals`
 * (V3-12) asks the number rather than the asset class, which is the difference
 * between a dust position reading `0.00000142` and reading `0` — and `0` is a
 * claim that the holding is empty, which is why it was hidden in the first
 * place being a different fact from it having no balance.
 */
function Balance({ balance }: { balance: string }) {
  return <Numeric value={balance} format="plain" decimals={amountDecimals(Number(balance))} />;
}

/**
 * Holdings kept off the dashboard — hidden by the user, auto-flagged as a
 * likely scam, or both.
 *
 * The reason is the only thing that decides what you can do about one, so it is
 * the row's badge, the surface's filter dimension, and what the peek's actions
 * are chosen by: a user-hidden holding can be unhidden, a scam-flagged one has
 * to be un-flagged, and a holding that is both needs both.
 *
 * Balances render with no currency: these are token *amounts*, not values —
 * the whole point of a hidden holding is that it is not counted, and putting a
 * currency symbol in front of 4,000,000 airdropped scam tokens would state the
 * opposite.
 */

interface HiddenHoldingsListProps {
  holdings: HiddenHoldingRow[];
  query: V3QueryState;
}

function ReasonBadge({ holding }: { holding: HiddenHoldingRow }) {
  if (isScamFlagged(holding)) {
    return (
      <Badge variant="outline" className="gap-1 border-border-strong">
        <ShieldAlert className="size-3" aria-hidden="true" />
        Likely scam
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <EyeOff className="size-3" aria-hidden="true" />
      Hidden
    </Badge>
  );
}

export function HiddenHoldingsList({ holdings, query }: HiddenHoldingsListProps) {
  const config: V3DataViewConfig<HiddenHoldingRow> = {
    pageKey: 'tokens:hidden',
    data: holdings,
    noun: 'hidden holdings',
    nounSingular: 'hidden holding',
    searchPlaceholder: 'Search hidden',
    searchFn: (holding, query) =>
      holding.token.symbol.toLowerCase().includes(query) ||
      holding.token.name.toLowerCase().includes(query),
    filterDefs: [
      {
        key: 'reason',
        label: 'Reason',
        options: [
          { value: 'user_hidden', label: 'Hidden by you' },
          { value: 'scam', label: 'Likely scam' },
        ],
        fn: (holding: HiddenHoldingRow, value) =>
          value === 'scam' ? isScamFlagged(holding) : holding.hiddenReason !== 'scam',
      },
    ],
    sortDefs: [
      { key: 'symbol', label: 'Symbol' },
      { key: 'balance', label: 'Balance' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      return field === 'balance'
        ? (Number(a.balance) - Number(b.balance)) * mult
        : a.token.symbol.localeCompare(b.token.symbol) * mult;
    },
    defaultSort: { field: 'symbol', direction: 'asc' },
    groupByDefs: [
      {
        key: 'institution',
        label: 'Institution',
        fn: (holding: HiddenHoldingRow) => holding.institution.name,
      },
    ],
    renderRow: (holding) => ({
      label: (
        <span className="flex items-center gap-2">
          {holding.token.symbol}
          <ReasonBadge holding={holding} />
        </span>
      ),
      sublabel: `${holding.token.name} · ${holding.account.name}`,
      value: <Balance balance={holding.balance} />,
      ariaLabel: `${holding.token.symbol}, ${hiddenReasonLabel(holding.hiddenReason)}`,
    }),
    columns: [
      {
        key: 'symbol',
        header: 'Token',
        sortable: true,
        width: 'w-[26%]',
        render: (holding) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-label">{holding.token.symbol}</span>
            <span className="truncate text-caption text-muted-foreground">
              {holding.token.name}
            </span>
          </span>
        ),
        exportValue: (holding) => exportText(holding.token.symbol),
      },
      {
        key: 'where',
        header: 'Account',
        render: (holding) => (
          <span className="truncate">{`${holding.institution.name} · ${holding.account.name}`}</span>
        ),
      },
      {
        key: 'reason',
        header: 'Reason',
        width: 'w-40',
        render: (holding) => <ReasonBadge holding={holding} />,
        exportValue: (holding) => exportText(hiddenReasonLabel(holding.hiddenReason)),
      },
      {
        key: 'balance',
        header: 'Balance',
        sortable: true,
        numeric: true,
        render: (holding) => <Balance balance={holding.balance} />,
        exportValue: (holding) =>
          exportNumber(holding.balance, amountDecimals(Number(holding.balance))),
      },
    ],
    empty: {
      icon: EyeOff,
      title: 'Nothing is hidden',
      description: 'Everything you own is counted on your dashboard.',
      action: (
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.holdings}>Back to holdings</Link>
        </Button>
      ),
    },
    peek: {
      basePath: TOKENS_HIDDEN_PATH,
      render: (holding) => ({
        title: holding.token.symbol,
        subtitle: holding.token.name,
        value: <Balance balance={holding.balance} />,
        primary: [
          { label: 'Why it is hidden', value: hiddenReasonLabel(holding.hiddenReason) },
          { label: 'Account', value: holding.account.name },
          { label: 'Institution', value: holding.institution.name },
          ...(isScamFlagged(holding)
            ? [
                {
                  label: 'Scam likelihood',
                  // `isScamProbability` is 0-1 and `format="percent"` appends a
                  // `%` to whatever it is given, so the scaling belongs here.
                  value: (
                    <Numeric
                      value={holding.token.isScamProbability * 100}
                      format="percent"
                      decimals={0}
                    />
                  ),
                },
              ]
            : []),
        ],
        actions: <HiddenHoldingActions holding={holding} />,
      }),
    },
  };

  return <V3DataView config={config} getId={(holding) => holding.id} query={query} />;
}
