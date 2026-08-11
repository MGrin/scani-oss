import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Loader2, Plus, Store } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import { V2_ROUTES } from '../lib/routes';

type VendorRow = RouterOutputs['vendors']['list'][number];

function VendorCard({ item, paymentCount }: { item: VendorRow; paymentCount: number }) {
  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="p-4">
        <p className="font-medium text-sm truncate">{item.displayName}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {item.category ?? 'Uncategorized'} · {paymentCount} payment{paymentCount === 1 ? '' : 's'}
        </p>
      </CardContent>
    </Card>
  );
}

/** Every vendor a payment has ever been pointed at, linking through to spend history + merge. */
export function VendorsPage() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { data: vendors, isLoading: vendorsLoading } = trpc.vendors.list.useQuery();
  const { data: payments, isLoading: paymentsLoading } = trpc.payments.list.useQuery();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const createMutation = trpc.vendors.create.useMutation({
    onSuccess: (vendor) => {
      showSuccess(`${vendor.displayName} created`);
      void utils.vendors.invalidate();
      setCreating(false);
      setNewName('');
      navigate(V2_ROUTES.vendorDetail(vendor.id));
    },
    onError: (error) => showError(error, 'Creating vendor'),
  });

  const isLoading = vendorsLoading || paymentsLoading;
  const items = vendors ?? [];

  const paymentCountByVendorId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const payment of payments ?? []) {
      counts.set(payment.vendorId, (counts.get(payment.vendorId) ?? 0) + 1);
    }
    return counts;
  }, [payments]);

  const columns: ColumnDef<VendorRow>[] = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (item) => <span className="font-medium text-sm">{item.displayName}</span>,
    },
    {
      key: 'category',
      label: 'Category',
      render: (item) => (
        <span className="text-sm text-muted-foreground">{item.category ?? '—'}</span>
      ),
    },
    {
      key: 'payments',
      label: 'Payments',
      align: 'right',
      sortable: true,
      render: (item) => (
        <span className="tabular-nums">{paymentCountByVendorId.get(item.id) ?? 0}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Vendors</h2>
          <p className="text-muted-foreground mt-1">{isLoading ? '' : `${items.length} vendors`}</p>
        </div>
        {!creating && (
          <Button size="sm" className="shrink-0" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New vendor
          </Button>
        )}
      </div>

      {creating && (
        <Card>
          <CardContent className="p-4 flex items-center gap-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Vendor name"
              disabled={createMutation.isPending}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) {
                  createMutation.mutate({ displayName: newName.trim() });
                }
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <Button
              size="sm"
              disabled={!newName.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate({ displayName: newName.trim() })}
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={createMutation.isPending}
              onClick={() => {
                setCreating(false);
                setNewName('');
              }}
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      <DataViewComponent
        config={{
          pageKey: 'vendors',
          data: items,
          searchFn: (item: VendorRow, query: string) =>
            item.displayName.toLowerCase().includes(query.toLowerCase()),
          sortDefs: [
            { key: 'name', label: 'Name' },
            { key: 'payments', label: 'Payments' },
          ],
          sortFn: (a: VendorRow, b: VendorRow, field: string, dir: string) => {
            const mult = dir === 'asc' ? 1 : -1;
            switch (field) {
              case 'name':
                return a.displayName.localeCompare(b.displayName) * mult;
              case 'payments':
                return (
                  ((paymentCountByVendorId.get(a.id) ?? 0) -
                    (paymentCountByVendorId.get(b.id) ?? 0)) *
                  mult
                );
              default:
                return 0;
            }
          },
          defaultSort: { field: 'name', direction: 'asc' },
          defaultView: 'table',
        }}
        columns={columns}
        renderCard={(item: VendorRow) => (
          <VendorCard item={item} paymentCount={paymentCountByVendorId.get(item.id) ?? 0} />
        )}
        onRowClick={(item: VendorRow) => navigate(V2_ROUTES.vendorDetail(item.id))}
        getId={(item: VendorRow) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Store className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">No vendors yet</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Vendors are created as you add recurring payments.
            </p>
          </div>
        }
      />
    </div>
  );
}
