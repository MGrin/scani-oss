import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { CardInteractive } from '@scani/ui/ui/card';
import { Repeat } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import {
  asPaymentIntervalUnit,
  formatPaymentInterval,
  monthlyEquivalent,
} from '../lib/paymentTotals';
import { V2_ROUTES } from '../lib/routes';

type PaymentRow = RouterOutputs['payments']['list'][number];

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
  ended: 'outline',
};

const STATUS_OPTIONS = [
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
  { label: 'Ended', value: 'ended' },
];

const DIRECTION_OPTIONS = [
  { label: 'Bill', value: 'outflow' },
  { label: 'Income', value: 'inflow' },
];

function PaymentCard({
  item,
  vendorName,
  currencySymbol,
}: {
  item: PaymentRow;
  vendorName: string;
  currencySymbol: string;
}) {
  const intervalUnit = asPaymentIntervalUnit(item.intervalUnit);
  return (
    <CardInteractive className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{vendorName}</span>
            <Badge
              variant={STATUS_VARIANT[item.status] ?? 'outline'}
              className="text-[10px] px-1.5 py-0 capitalize"
            >
              {item.status}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {formatPaymentInterval(intervalUnit, item.intervalCount)}
            {item.direction === 'inflow' ? ' · Income' : ' · Bill'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold tabular-nums">
            {item.expectedAmount ? formatCurrency(item.expectedAmount, currencySymbol) : '—'}
          </p>
        </div>
      </div>
    </CardInteractive>
  );
}

/** Every recurring payment on record, linking through to its own detail page. */
export function PaymentsPage() {
  const navigate = useNavigate();
  const { data: payments, isLoading: paymentsLoading } = trpc.payments.list.useQuery();
  const { data: vendors, isLoading: vendorsLoading } = trpc.vendors.list.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();

  const isLoading = paymentsLoading || vendorsLoading || tokensLoading;
  const vendorNameById = new Map((vendors ?? []).map((v) => [v.id, v.displayName]));
  const tokenSymbolById = new Map((tokens ?? []).map((t) => [t.id, t.symbol]));
  const items = payments ?? [];

  const columns: ColumnDef<PaymentRow>[] = [
    {
      key: 'vendor',
      label: 'Vendor',
      sortable: true,
      render: (item) => (
        <span className="font-medium text-sm">
          {vendorNameById.get(item.vendorId) ?? 'Unknown vendor'}
        </span>
      ),
    },
    {
      key: 'direction',
      label: 'Direction',
      render: (item) => (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
          {item.direction === 'inflow' ? 'Income' : 'Bill'}
        </Badge>
      ),
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      sortable: true,
      render: (item) => {
        const symbol = tokenSymbolById.get(item.currencyTokenId) ?? 'USD';
        const intervalUnit = asPaymentIntervalUnit(item.intervalUnit);
        const monthly = item.expectedAmount
          ? monthlyEquivalent(item.expectedAmount, intervalUnit, item.intervalCount)
          : null;
        return (
          <p className="font-medium tabular-nums">
            {item.expectedAmount ? formatCurrency(item.expectedAmount, symbol) : '—'}
            {monthly && (
              <span className="ml-1.5 font-normal text-[11px] text-muted-foreground">
                (≈ {formatCurrency(monthly.toString(), symbol)}/mo)
              </span>
            )}
          </p>
        );
      },
    },
    {
      key: 'cadence',
      label: 'Cadence',
      render: (item) => (
        <span className="text-sm text-muted-foreground">
          {formatPaymentInterval(asPaymentIntervalUnit(item.intervalUnit), item.intervalCount)}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (item) => (
        <Badge
          variant={STATUS_VARIANT[item.status] ?? 'outline'}
          className="text-[10px] px-1.5 py-0 capitalize"
        >
          {item.status}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Recurring Payments</h2>
          <p className="text-muted-foreground mt-1">
            {isLoading ? '' : `${items.length} payments`}
          </p>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link to={V2_ROUTES.paymentCreate}>Add payment</Link>
        </Button>
      </div>

      <DataViewComponent
        config={{
          pageKey: 'payments',
          data: items,
          searchFn: (item: PaymentRow, query: string) => {
            const vendorName = vendorNameById.get(item.vendorId) ?? '';
            return vendorName.toLowerCase().includes(query.toLowerCase());
          },
          filterDefs: [
            {
              key: 'direction',
              label: 'Direction',
              options: DIRECTION_OPTIONS,
              fn: (item: PaymentRow, value: string) => item.direction === value,
            },
            {
              key: 'status',
              label: 'Status',
              options: STATUS_OPTIONS,
              fn: (item: PaymentRow, value: string) => item.status === value,
            },
          ],
          sortDefs: [
            { key: 'vendor', label: 'Vendor' },
            { key: 'amount', label: 'Amount' },
            { key: 'status', label: 'Status' },
          ],
          sortFn: (a: PaymentRow, b: PaymentRow, field: string, dir: string) => {
            const mult = dir === 'asc' ? 1 : -1;
            switch (field) {
              case 'vendor':
                return (
                  (vendorNameById.get(a.vendorId) ?? '').localeCompare(
                    vendorNameById.get(b.vendorId) ?? ''
                  ) * mult
                );
              case 'amount':
                return (
                  (Number.parseFloat(a.expectedAmount ?? '0') -
                    Number.parseFloat(b.expectedAmount ?? '0')) *
                  mult
                );
              case 'status':
                return a.status.localeCompare(b.status) * mult;
              default:
                return 0;
            }
          },
          defaultSort: { field: 'vendor', direction: 'asc' },
          defaultView: 'table',
        }}
        columns={columns}
        renderCard={(item: PaymentRow) => (
          <PaymentCard
            item={item}
            vendorName={vendorNameById.get(item.vendorId) ?? 'Unknown vendor'}
            currencySymbol={tokenSymbolById.get(item.currencyTokenId) ?? 'USD'}
          />
        )}
        onRowClick={(item: PaymentRow) => navigate(V2_ROUTES.paymentDetail(item.id))}
        getId={(item: PaymentRow) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Repeat className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">No recurring payments yet</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Add a bill or recurring income to start tracking it.
            </p>
            <Button asChild size="sm" className="mt-3">
              <Link to={V2_ROUTES.paymentCreate}>Add payment</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
