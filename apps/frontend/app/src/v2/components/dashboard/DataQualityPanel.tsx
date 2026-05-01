import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';

// Surfaces per-(account, token) coverage metadata so users understand
// WHY the history chart has gaps / dashed segments, and what they can
// do about it. Direct mirror of the `holding_coverage` table plus a
// CTA layer keyed off coverage quality.
//
// Reads `portfolio.getCoverage`. Expands per account; a collapsed
// variant lives below as the default view for brevity.

interface CoverageRow {
  accountId: string;
  tokenId: string;
  firstTxAt: Date | string | null;
  lastTxAt: Date | string | null;
  firstObservationAt: Date | string | null;
  lastObservationAt: Date | string | null;
  txSources: string[];
  hasCompleteTxHistory: boolean;
  openingBalanceQuantity: string | null;
}

interface AccountAggregate {
  accountId: string;
  tokenCount: number;
  coveredTokenCount: number;
  txSourceSet: Set<string>;
  firstTxAt: Date | null;
  lastObservationAt: Date | null;
  openingSynthesized: number;
}

function parseDate(v: Date | string | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

function aggregateByAccount(rows: CoverageRow[]): AccountAggregate[] {
  const map = new Map<string, AccountAggregate>();
  for (const r of rows) {
    const agg = map.get(r.accountId) ?? {
      accountId: r.accountId,
      tokenCount: 0,
      coveredTokenCount: 0,
      txSourceSet: new Set<string>(),
      firstTxAt: null,
      lastObservationAt: null,
      openingSynthesized: 0,
    };
    agg.tokenCount += 1;
    if (r.txSources.length > 0) agg.coveredTokenCount += 1;
    for (const s of r.txSources) agg.txSourceSet.add(s);
    const first = parseDate(r.firstTxAt);
    if (first && (!agg.firstTxAt || first.getTime() < agg.firstTxAt.getTime())) {
      agg.firstTxAt = first;
    }
    const lastObs = parseDate(r.lastObservationAt);
    if (
      lastObs &&
      (!agg.lastObservationAt || lastObs.getTime() > agg.lastObservationAt.getTime())
    ) {
      agg.lastObservationAt = lastObs;
    }
    if (r.openingBalanceQuantity) agg.openingSynthesized += 1;
    map.set(r.accountId, agg);
  }
  return [...map.values()];
}

export function DataQualityPanel() {
  const { data: coverageData, isLoading } = trpc.portfolio.getCoverage.useQuery();
  const { data: accountsData } = trpc.accounts.getAll.useQuery();

  const aggregates = useMemo(
    () => (coverageData ? aggregateByAccount(coverageData.rows as CoverageRow[]) : []),
    [coverageData]
  );

  // Look up account names when available. Falls back to id-suffix if the
  // accounts list shape is different from expected (defensive, because
  // we're reading whatever endpoint exists without adding another).
  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    const list = (accountsData as unknown as Array<{ id: string; name: string }>) ?? [];
    if (Array.isArray(list)) {
      for (const a of list) m.set(a.id, a.name);
    }
    return m;
  }, [accountsData]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Data quality</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (aggregates.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Data quality</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No account coverage data yet. Connect an integration, upload a statement, or enter a
            manual transaction to start building history.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Data quality</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {aggregates.map((a) => {
          const coverageRatio = a.tokenCount > 0 ? a.coveredTokenCount / a.tokenCount : 0;
          const barPercent = Math.round(coverageRatio * 100);
          const sourceList = [...a.txSourceSet].sort().join(', ') || 'no tx sources yet';
          const name = accountNameById.get(a.accountId) ?? a.accountId.slice(0, 8);
          return (
            <div key={a.accountId} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{name}</span>
                <span className="text-xs text-muted-foreground">
                  {a.coveredTokenCount} / {a.tokenCount} with tx history
                </span>
              </div>
              <div className="h-2 w-full rounded bg-muted overflow-hidden">
                <div
                  className={`h-full ${barPercent >= 75 ? 'bg-emerald-500' : barPercent >= 25 ? 'bg-amber-500' : 'bg-rose-500'}`}
                  style={{ width: `${barPercent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Sources: {sourceList}
                {a.firstTxAt
                  ? ` · earliest tx ${a.firstTxAt.toISOString().slice(0, 10)}`
                  : ' · no transactions imported'}
                {a.openingSynthesized > 0
                  ? ` · ${a.openingSynthesized} synthesized opening balance${
                      a.openingSynthesized === 1 ? '' : 's'
                    }`
                  : ''}
              </p>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground pt-2 border-t">
          Upload a bank/broker statement or import transactions from your exchange to extend
          history. Without that, new accounts chart balances only from when they were connected.
        </p>
      </CardContent>
    </Card>
  );
}
