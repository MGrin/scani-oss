import type { HoldingWithDetails } from '@scani/shared';
import { CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { useBaseCurrency } from '@/v2/hooks/useBaseCurrency';
import { formatMoney } from '@/v2/lib/format';
import { V2_ROUTES } from '@/v2/lib/routes';
import { ScamBadge } from '../ScamBadge';

interface WalletImportResultProps {
  result: unknown;
  jobId?: string;
  actionTakenAt?: Date | string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Detail-page body for `wallet-import` jobs. Renders the imported holdings
 * grouped by chain (institution), with per-row Delete + per-token
 * Mark-as-scam actions. Prices and values use the user's base currency.
 *
 * Data flow:
 *   1. `holdings.getWithDetails` (with `includeScamTokens=true` so freshly
 *      flagged tokens stay visible on the review screen) returns every
 *      holding for the user.
 *   2. We intersect with `result.holdingIds` from the job row — so older
 *      holdings from prior imports stay out of this review.
 *
 * Falls back to a counts-only summary when the job had no `holdingIds`
 * field (older completed jobs predating this feature).
 */
export function WalletImportResult({ result, jobId, actionTakenAt }: WalletImportResultProps) {
  const r = asRecord(result);
  const holdingIds = Array.isArray(r.holdingIds) ? (r.holdingIds as string[]) : null;
  const accountsCreated = Number(r.accountsCreated ?? 0);
  const holdingsCreated = Number(r.holdingsCreated ?? 0);
  const chainsDetectedRaw = r.chainsDetected;
  const chainsCount =
    typeof chainsDetectedRaw === 'number'
      ? chainsDetectedRaw
      : Array.isArray(chainsDetectedRaw)
        ? chainsDetectedRaw.length
        : 0;
  const chainsList = Array.isArray(chainsDetectedRaw) ? (chainsDetectedRaw as string[]) : null;
  const errors = Array.isArray(r.errors) ? (r.errors as unknown[]) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Imported holdings</CardTitle>
        <p className="text-xs text-muted-foreground">
          {holdingsCreated} holding{holdingsCreated === 1 ? '' : 's'} across {accountsCreated}{' '}
          account{accountsCreated === 1 ? '' : 's'}
          {chainsList?.length
            ? ` · ${chainsList.join(', ')}`
            : chainsCount
              ? ` · ${chainsCount} chain${chainsCount === 1 ? '' : 's'}`
              : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {holdingIds && holdingIds.length > 0 ? (
          <HoldingsReviewTable
            holdingIds={holdingIds}
            jobId={jobId}
            actionTakenAt={actionTakenAt}
          />
        ) : (
          <EmptyImportState chainsCount={chainsCount} accountsCreated={accountsCreated} />
        )}
        {errors.length > 0 && (
          <div className="text-xs rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <div className="font-medium mb-1">{errors.length} import error(s)</div>
            <ul className="list-disc pl-4 space-y-0.5 font-mono">
              {errors.slice(0, 5).map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: error messages don't have ids
                <li key={i}>{typeof e === 'string' ? e : JSON.stringify(e)}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyImportState({
  chainsCount,
  accountsCreated,
}: {
  chainsCount: number;
  accountsCreated: number;
}) {
  if (chainsCount === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No chains were detected for this address. The wallet may not have activity on any chain the
        app currently supports, or the detection RPCs were rate-limited. Try the import again in a
        minute or two.
      </p>
    );
  }
  if (accountsCreated === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Chains were detected but no accounts were created. This usually means a provider API
        rejected the balance fetch. Check the worker logs for details.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Accounts were created but no holdings were imported. The wallet likely has a zero balance on
      every detected chain, or a balance provider timed out. Open the holdings page to manage.
    </p>
  );
}

/**
 * Groups rows by chain, preserving insertion order — both for the group
 * list and for rows inside each group. We iterate `holdingIds` (the
 * authoritative insertion order from the job result) so the rendering
 * is stable across mark-scam / delete mutations. Sorting by `value`
 * here caused rows to shuffle whenever a price refetch nudged any value.
 */
function groupByInstitution(
  rows: HoldingWithDetails[],
  orderedIds: string[]
): Array<[string, HoldingWithDetails[]]> {
  const byId = new Map(rows.map((h) => [h.id, h]));
  const groups = new Map<string, HoldingWithDetails[]>();
  for (const id of orderedIds) {
    const h = byId.get(id);
    if (!h) continue;
    const key = h.institution.name;
    const bucket = groups.get(key);
    if (bucket) bucket.push(h);
    else groups.set(key, [h]);
  }
  return Array.from(groups.entries());
}

function HoldingsReviewTable({
  holdingIds,
  jobId,
  actionTakenAt,
}: {
  holdingIds: string[];
  jobId?: string;
  actionTakenAt?: Date | string | null;
}) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { symbol: currency } = useBaseCurrency();
  const query = trpc.holdings.getWithDetails.useQuery();
  const deleteMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      showSuccess('Holding deleted');
      void utils.holdings.getWithDetails.invalidate();
    },
    onError: (err) => showError(err, 'delete holding'),
  });
  const markActionTakenMutation = trpc.jobs.markActionTaken.useMutation();

  const alreadyActed = Boolean(actionTakenAt);

  const finishReview = async () => {
    if (jobId) {
      try {
        await markActionTakenMutation.mutateAsync({ jobId });
        await Promise.all([
          utils.jobs.getMine.invalidate({ jobId }),
          utils.jobs.listMine.invalidate(),
        ]);
      } catch {
        // UX guard only — stamp failures shouldn't block navigation.
      }
    }
    await invalidatePortfolioQueries(utils);
    navigate(V2_ROUTES.holdings);
  };

  const ids = new Set(holdingIds);
  const allHoldings = (query.data?.holdings ?? []) as HoldingWithDetails[];
  const rows = allHoldings.filter((h) => ids.has(h.id));

  if (query.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading holdings…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        None of the imported holdings are currently visible (they may have been deleted or marked as
        scam).
      </p>
    );
  }

  if (alreadyActed) {
    const when = actionTakenAt instanceof Date ? actionTakenAt : new Date(String(actionTakenAt));
    const whenLabel = Number.isNaN(when.getTime()) ? '' : when.toLocaleString();
    return (
      <div className="flex items-start gap-2 rounded-md border bg-muted/20 p-3">
        <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Review finished{whenLabel ? ` on ${whenLabel}` : ''}. The imported holdings are live in
            your portfolio. You can still delete them from the holdings page.
          </p>
          <Button variant="outline" size="sm" asChild className="h-7 text-xs">
            <a href={V2_ROUTES.holdings}>View holdings</a>
          </Button>
        </div>
      </div>
    );
  }

  const groups = groupByInstitution(rows, holdingIds);

  return (
    <div className="space-y-4">
      {groups.map(([chainName, chainRows]) => {
        const groupTotal = chainRows.reduce((acc, it) => acc + (Number(it.value) || 0), 0);
        return (
          <div key={chainName} className="space-y-1.5">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {chainName}
                <span className="ml-2 text-[10px] font-normal normal-case tracking-normal">
                  {chainRows.length} holding{chainRows.length === 1 ? '' : 's'}
                </span>
              </h3>
              <span className="text-xs font-medium tabular-nums">
                {formatMoney(groupTotal, currency)}
              </span>
            </div>
            <div className="border rounded-md divide-y">
              {chainRows.map((h) => (
                <div key={h.id} className="flex items-start gap-2 p-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium shrink-0">{h.token.symbol}</span>
                      <span className="text-muted-foreground truncate text-xs">{h.token.name}</span>
                      <ScamBadge probability={h.token.isScamProbability} />
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 truncate tabular-nums">
                      {h.amount} · {h.account.name}
                    </div>
                  </div>
                  <div className="flex items-start gap-1 shrink-0">
                    <div className="text-right leading-tight">
                      <div className="text-sm font-medium tabular-nums whitespace-nowrap">
                        {formatMoney(h.value, currency)}
                      </div>
                      {h.price && (
                        <div className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                          @ {formatMoney(h.price.value, currency, { decimals: 4 })}
                        </div>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete holding"
                      className="h-7 w-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={deleteMutation.isLoading}
                      onClick={() => deleteMutation.mutate({ id: h.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {jobId && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground">
            Prune unwanted rows above, then confirm. Until you finish reviewing, this job stays in
            your Jobs list as needing action.
          </p>
          <Button
            type="button"
            size="sm"
            className="shrink-0 w-full sm:w-auto"
            disabled={markActionTakenMutation.isPending}
            onClick={() => {
              void finishReview();
            }}
          >
            {markActionTakenMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Finishing…
              </>
            ) : (
              'Done reviewing'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
