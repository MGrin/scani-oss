import { formatDate } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';

interface AccountTransactionsListProps {
  accountId: string;
}

const PAGE_SIZE = 50;

// Transaction kinds that increase a holding's balance — rendered with a
// positive (green) quantity. Everything else (sell, withdraw, fee, …) is
// an outflow and rendered red.
const INFLOW_KINDS = new Set([
  'buy',
  'deposit',
  'transfer_in',
  'swap_in',
  'reward',
  'interest',
  'airdrop',
  'opening_balance',
]);

export function AccountTransactionsList({ accountId }: AccountTransactionsListProps) {
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isFetching } = trpc.transactions.list.useQuery({
    accountId,
    limit: PAGE_SIZE,
    offset,
  });
  // Reuses the holdings query the parent already issued (shared
  // react-query cache) to map holding_id → token symbol, since the
  // transactions endpoint returns raw rows without the token joined.
  const { data: holdingsData } = trpc.accounts.getHoldings.useQuery({ id: accountId });

  const symbolByHolding = useMemo(() => {
    const holdings = Array.isArray(holdingsData) ? holdingsData : (holdingsData?.holdings ?? []);
    const map = new Map<string, string>();
    for (const h of holdings as Array<{ id?: string; token?: { symbol?: string } }>) {
      if (h?.id && h.token?.symbol) map.set(h.id, h.token.symbol);
    }
    return map;
  }, [holdingsData]);

  const transactions = data?.transactions ?? [];
  const hasNextPage = transactions.length === PAGE_SIZE;

  return (
    <div>
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Transactions</p>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No transactions for this account yet.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Token</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((tx) => {
                const qty = Number(tx.quantity);
                const inflow = INFLOW_KINDS.has(tx.kind);
                return (
                  <TableRow key={tx.id}>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatDate(tx.occurredAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {tx.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      {symbolByHolding.get(tx.holdingId) ?? '—'}
                    </TableCell>
                    <TableCell
                      className={`text-right text-sm tabular-nums ${
                        inflow ? 'text-emerald-600' : 'text-rose-600'
                      }`}
                    >
                      {Number.isFinite(qty) ? qty.toLocaleString() : tx.quantity}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {(offset > 0 || hasNextPage) && (
            <div className="flex items-center justify-between mt-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0 || isFetching}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{offset + transactions.length}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasNextPage || isFetching}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
