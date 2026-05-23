import type { HoldingWithDetails } from '@scani/shared';
import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { useBaseCurrency } from '@/v2/hooks/useBaseCurrency';
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

  // Two render paths:
  //  1. Newer (review-aware) jobs: result has `needsReview: true` + a
  //     `chains` array of pre-fetched candidates. The user picks which
  //     to keep, then `walletImport.confirmHoldings` runs the actual
  //     import on the API side.
  //  2. Older (auto-create) jobs: result has `holdingIds` and we render
  //     the post-import review/delete UI. Kept here so jobs from before
  //     the review-aware refactor still render.
  if (r.needsReview === true && Array.isArray(r.chains) && jobId) {
    return (
      <WalletImportReviewCard
        jobId={jobId}
        chains={r.chains as WalletReviewChainShape[]}
        actionTakenAt={actionTakenAt}
      />
    );
  }

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
    await invalidatePortfolioQueries(utils, { refetchType: 'all' });
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
                {formatCurrency(groupTotal, currency)}
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
                        {formatCurrency(h.value, currency)}
                      </div>
                      {h.price && (
                        <div className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                          @ {formatCurrency(h.price.value, currency, { decimals: 4 })}
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

// ============================================================
// Review-aware path: pick which of the detected balances to keep
// before any holding is created.
// ============================================================

interface WalletReviewSnapshotShape {
  externalId: string;
  balance: string;
  capturedAt: string;
  tokenIdentity: {
    symbol?: string;
    name?: string;
    decimals?: number;
    iconUrl?: string | null;
    providerMetadata?: unknown;
  };
}

interface WalletReviewChainShape {
  institutionId: string;
  institutionName: string;
  institutionCode: string;
  chainId: string;
  accountName: string;
  preExistingAccountId?: string;
  snapshots: WalletReviewSnapshotShape[];
}

// Heuristic spam filter — mirrors the patterns we see in EVM tokentx
// scams (homoglyph "USDC" with Cyrillic letters, "claim until …" tokens,
// telegram/website URLs in the symbol, etc.). Pre-checked to false in
// the review UI so a wallet with 200 spam tokens defaults to clean.
function looksLikeSpam(snap: WalletReviewSnapshotShape): boolean {
  const sym = snap.tokenIdentity.symbol ?? '';
  const name = snap.tokenIdentity.name ?? '';
  const blob = `${sym} ${name}`.toLowerCase();
  if (/(t\.me|t\.ly|claim|airdrop|reward|swap-based|[$]\s*\d|opensea|metawin)/i.test(blob)) {
    return true;
  }
  // Cyrillic letters that homoglyph Latin (a, e, o, p, c, x, y, ѕ, і, …)
  if (/[Ѐ-ӿ]/.test(sym + name)) return true;
  return false;
}

function WalletImportReviewCard({
  jobId,
  chains,
  actionTakenAt,
}: {
  jobId: string;
  chains: WalletReviewChainShape[];
  actionTakenAt?: Date | string | null;
}) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const alreadyActed = Boolean(actionTakenAt);

  // selectedKeys is keyed `${institutionId}:${externalId}` so the same
  // externalId on different chains stays disambiguated.
  const initialSelected = useMemo(() => {
    const set = new Set<string>();
    for (const chain of chains) {
      for (const snap of chain.snapshots) {
        if (!looksLikeSpam(snap)) {
          set.add(`${chain.institutionId}:${snap.externalId}`);
        }
      }
    }
    return set;
  }, [chains]);
  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [hideSpam, setHideSpam] = useState(true);

  const totalCandidates = chains.reduce((acc, c) => acc + c.snapshots.length, 0);
  const spamCount = chains.reduce((acc, c) => acc + c.snapshots.filter(looksLikeSpam).length, 0);

  const confirmMutation = trpc.wallet.confirmHoldings.useMutation({
    onSuccess: async (data) => {
      showSuccess(
        `Imported ${data.holdingsCreated} holding${data.holdingsCreated === 1 ? '' : 's'}`
      );
      await Promise.all([
        utils.jobs.getMine.invalidate({ jobId }),
        utils.jobs.listMine.invalidate(),
        invalidatePortfolioQueries(utils, { refetchType: 'all' }),
      ]);
      navigate(V2_ROUTES.holdings);
    },
    onError: (err) => showError(err, 'Confirming wallet import'),
  });

  if (alreadyActed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Wallet imported</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <div className="flex items-start gap-2 rounded-md border bg-muted/20 p-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
            <p>This wallet's holdings have already been confirmed and imported.</p>
          </div>
          <Button variant="outline" size="sm" asChild className="h-7 text-xs">
            <a href={V2_ROUTES.holdings}>View holdings</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const confirm = () => {
    const kept = Array.from(selected).map((k) => {
      const idx = k.indexOf(':');
      return { institutionId: k.slice(0, idx), externalId: k.slice(idx + 1) };
    });
    if (kept.length === 0) return;
    confirmMutation.mutate({ pickerJobId: jobId, kept });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Review detected holdings</CardTitle>
        <p className="text-xs text-muted-foreground">
          We found {totalCandidates} token{totalCandidates === 1 ? '' : 's'} across {chains.length}{' '}
          chain{chains.length === 1 ? '' : 's'}. Pick which to keep — only the selected ones will be
          created. {spamCount > 0 ? `${spamCount} look like spam.` : ''}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="flex items-center gap-2 cursor-pointer"
              onClick={() => setHideSpam((v) => !v)}
            >
              <Checkbox
                checked={hideSpam}
                onCheckedChange={(v) => setHideSpam(v === true)}
                className="pointer-events-none"
              />
              <span>Hide likely spam ({spamCount})</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground tabular-nums">
              {selected.size} of {totalCandidates}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => {
                // Select-all skips currently-hidden rows (spam filter
                // is on). Acting only on what the user can see matches
                // the mental model — "tick everything I see".
                const next = new Set(selected);
                for (const chain of chains) {
                  for (const snap of chain.snapshots) {
                    if (hideSpam && looksLikeSpam(snap)) continue;
                    next.add(`${chain.institutionId}:${snap.externalId}`);
                  }
                }
                setSelected(next);
              }}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => setSelected(new Set())}
            >
              Deselect all
            </Button>
          </div>
        </div>

        {chains.map((chain) => {
          const visibleSnaps = chain.snapshots.filter((s) => !hideSpam || !looksLikeSpam(s));
          if (visibleSnaps.length === 0) return null;
          return (
            <div key={chain.institutionId} className="space-y-1.5">
              <div className="flex items-center justify-between px-0.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {chain.institutionName}
                  <span className="ml-2 text-[10px] font-normal normal-case tracking-normal">
                    {visibleSnaps.length} of {chain.snapshots.length} shown
                  </span>
                </h3>
              </div>
              <div className="border rounded-md divide-y">
                {visibleSnaps.map((snap) => {
                  const key = `${chain.institutionId}:${snap.externalId}`;
                  const checked = selected.has(key);
                  const spam = looksLikeSpam(snap);
                  return (
                    <button
                      type="button"
                      key={snap.externalId}
                      onClick={() => toggle(key)}
                      className="flex w-full items-start gap-2 p-2.5 text-sm text-left cursor-pointer hover:bg-accent/30"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(key)}
                        className="mt-1 pointer-events-none"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-medium shrink-0">
                            {snap.tokenIdentity.symbol ?? '?'}
                          </span>
                          <span className="text-muted-foreground truncate text-xs">
                            {snap.tokenIdentity.name ?? snap.externalId}
                          </span>
                          {spam ? (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 border-amber-500 text-amber-600"
                            >
                              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                              spam
                            </Badge>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5 truncate tabular-nums">
                          {snap.balance}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
          <p className="text-xs text-muted-foreground">
            Holdings get created and priced after you confirm.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={selected.size === 0 || confirmMutation.isPending}
            onClick={confirm}
          >
            {confirmMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Importing…
              </>
            ) : (
              `Import ${selected.size} holding${selected.size === 1 ? '' : 's'}`
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
