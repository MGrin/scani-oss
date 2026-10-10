import { balanceDecimals, formatDate } from '@scani/shared';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { activityKindLabel } from '../../lib/holding-activity';
import { V3_ROUTES } from '../../lib/routes';

const HOLDING_ACTIVITY_LIMIT = 10;

interface HoldingActivityProps {
  holdingId: string;
  symbol: string;
  tokenTypeCode: string | null | undefined;
}

/**
 * The holding's latest ledger rows, newest first (SC-1527).
 *
 * A movement recorded from this peek wrote its rows and then showed up nowhere,
 * so the reader had no way to confirm it had happened short of reading the
 * balance and doing the arithmetic. This is the list that answers "did it go
 * in", and nothing more: no paging, no editing. Like `RealizedLedger` it
 * renders itself away when there is nothing to list, including while loading.
 */
export function HoldingActivity({ holdingId, symbol, tokenTypeCode }: HoldingActivityProps) {
  const { t } = useTranslation();
  const activity = trpc.transactions.list.useQuery({ holdingId, limit: HOLDING_ACTIVITY_LIMIT });

  const rows = activity.data?.transactions ?? [];
  if (rows.length === 0) return null;
  const dividendIds = new Set(
    rows.filter((row) => row.kindSubtype === 'dividend').map((row) => row.id)
  );

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
          {t('v3.holdings.activity.heading')}
        </h3>
        <Link
          to={`${V3_ROUTES.transactions}?holding=${holdingId}`}
          className="text-label text-primary hover:underline"
        >
          {t('v3.transactions.seeAll')}
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="flex items-baseline justify-between gap-4 py-2">
            <span className="flex min-w-0 flex-col">
              <span className="text-body">{activityKindLabel(t, row, dividendIds)}</span>
              <span className="truncate text-caption text-muted-foreground">
                {row.description
                  ? `${formatDate(row.occurredAt)} · ${row.description}`
                  : formatDate(row.occurredAt)}
              </span>
            </span>
            <span className="flex shrink-0 items-baseline gap-1 text-body">
              <Numeric
                value={row.quantity}
                format="plain"
                decimals={balanceDecimals(row.quantity, tokenTypeCode)}
                delta
                indicator="sign"
              />
              <span className="text-caption text-muted-foreground">{symbol}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
