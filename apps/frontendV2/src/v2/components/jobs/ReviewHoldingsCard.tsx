import { ArrowLeft, Check, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '../../hooks/invalidatePortfolioQueries';
import { V2_ROUTES } from '../../lib/routes';

/**
 * Reusable review + confirm card for extracted holdings. Used by
 * FileImportPage (inline after upload) AND by ScreenshotParseResult /
 * FileImportResult on `/jobs/:jobId` so a user who navigated away from
 * the upload page mid-job can still finish the import.
 *
 * Scope intentionally narrow: requires an existing `accountId`. The
 * "create a new account inline" flow stays on FileImportPage because
 * its state (new-account name, new-institution picker) isn't durably
 * persisted in the job record today. Users who picked an existing
 * account get the full review here.
 */
export interface ReviewHoldingInput {
  symbol: string;
  name?: string | null;
  balance: string;
  confidence?: number;
  tokenId?: string | null;
  holdingId?: string | null;
  existingBalance?: string | null;
}

interface Row extends ReviewHoldingInput {
  /** Client-side stable id — source holdings rarely have one. */
  clientId: string;
  removed: boolean;
  balance: string;
}

interface ReviewHoldingsCardProps {
  accountId: string;
  holdings: ReviewHoldingInput[];
  /** Optional banner label (e.g. "Screenshot" / "Bank Statement"). */
  fileSource?: 'screenshot' | 'statement';
  /** Optional overall-confidence badge (shown when present). */
  overallConfidence?: number | null;
  /** Heading for the review card. */
  title?: string;
  /**
   * When set via `ReviewHoldingsCard` on `/jobs/:jobId`, the save
   * callback stamps `user_jobs.action_taken_at` on this job so revisits
   * render read-only. Without it the card is still usable (inline flow
   * inside FileImportPage's own upload path) but without one-shot
   * enforcement.
   */
  jobId?: string;
  /** Existing stamp, if any — flips the card into read-only mode. */
  actionTakenAt?: string | Date | null;
}

function makeRow(h: ReviewHoldingInput, idx: number): Row {
  return {
    ...h,
    balance: h.balance ?? '0',
    removed: false,
    clientId: `rev-${idx}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export function ReviewHoldingsCard({
  accountId,
  holdings,
  fileSource,
  overallConfidence,
  title = 'Review & edit holdings',
  jobId,
  actionTakenAt,
}: ReviewHoldingsCardProps) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Read-only latch: once the job's `action_taken_at` is set, we render
  // a compact confirmation instead of the editable review table — no way
  // to re-import the same extracted holdings. Set by the server when the
  // save mutations below succeed; persists across tabs / sessions.
  const alreadyActed = Boolean(actionTakenAt);

  // Re-derive state when the holdings prop changes (e.g., the job result
  // fetch completes after initial render). Using useMemo + local state
  // would require a useEffect; easier to key the rows by the source
  // holdings array identity.
  const [rows, setRows] = useState<Row[]>(() => holdings.map(makeRow));

  const markActionTakenMutation = trpc.jobs.markActionTaken.useMutation();

  // After either save path resolves, stamp the job (if we have one) so
  // the user can't re-trigger the import from a reload / back-nav. We
  // fire-and-forget: even if the stamp fails (offline), the holdings
  // write already committed and the guard is a UX defense, not a
  // correctness gate. The server-side `action_taken_at IS NULL` clause
  // in the SQL UPDATE is the real enforcement.
  const finalize = async () => {
    if (jobId) {
      try {
        await markActionTakenMutation.mutateAsync({ jobId });
        // Invalidate BOTH the single-job cache (so the review card re-
        // renders as read-only if the user navigates back) and the
        // list cache (so the top-nav badge + sidebar chip recompute
        // `actionRequiredCount` and drop this job from the count
        // without needing a page reload).
        await Promise.all([
          utils.jobs.getMine.invalidate({ jobId }),
          utils.jobs.listMine.invalidate(),
        ]);
      } catch {
        // swallow — UI guard only.
      }
    }
    await invalidatePortfolioQueries(utils);
    navigate(V2_ROUTES.holdings);
  };

  // We drive the two save mutations from `handleSave` with mutateAsync
  // + Promise.all so a screenshot that mixes existing + new holdings
  // fires one coordinated save, not two fire-and-forget requests that
  // each race to call `finalize()`. The previous shape emitted two
  // toasts, double-invalidated the portfolio cache, and double-called
  // markActionTaken on every mixed-save.
  const createMutation = trpc.batchOperations.createHoldingsWithDependencies.useMutation({
    onError: (err) => showError(err, 'Saving holdings'),
  });
  const updateBatchMutation = trpc.batchOperations.updateHoldingsBatch.useMutation({
    onError: (err) => showError(err, 'Updating holdings'),
  });

  const isSaving = createMutation.isPending || updateBatchMutation.isPending;

  const { activeRows, newHoldings, updateHoldings, unmatchedHoldings } = useMemo(() => {
    const active = rows.filter((h) => !h.removed);
    return {
      activeRows: active,
      newHoldings: active.filter((h) => h.tokenId && !h.holdingId),
      updateHoldings: active.filter((h) => h.holdingId),
      unmatchedHoldings: active.filter((h) => !h.tokenId),
    };
  }, [rows]);

  const toggleRemove = (clientId: string) => {
    setRows((prev) =>
      prev.map((r) => (r.clientId === clientId ? { ...r, removed: !r.removed } : r))
    );
  };

  const setBalance = (clientId: string, balance: string) => {
    setRows((prev) => prev.map((r) => (r.clientId === clientId ? { ...r, balance } : r)));
  };

  const handleSave = async () => {
    const toUpdate = updateHoldings.filter((h) => h.holdingId && h.balance);
    const toCreate = newHoldings.filter((h) => h.tokenId && h.balance);

    if (toCreate.length === 0 && toUpdate.length === 0) {
      showError('No valid holdings to import', 'Import');
      return;
    }

    // Coordinate both saves so finalize() runs exactly once — see comment
    // on the mutation definitions above for the race this replaces.
    try {
      const tasks: Promise<unknown>[] = [];
      if (toUpdate.length > 0) {
        tasks.push(
          updateBatchMutation.mutateAsync({
            holdings: toUpdate.map((h) => ({ id: h.holdingId as string, balance: h.balance })),
          })
        );
      }
      if (toCreate.length > 0) {
        tasks.push(
          createMutation.mutateAsync({
            accountId,
            holdings: toCreate.map((h) => ({
              tokenId: h.tokenId as string,
              balance: h.balance,
            })),
          })
        );
      }
      await Promise.all(tasks);
    } catch {
      // Per-mutation onError already surfaced a toast — bail before
      // finalize() so we don't stamp action_taken or navigate on partial
      // failure.
      return;
    }

    // Single success toast covering both paths.
    const total = toCreate.length + toUpdate.length;
    showSuccess(`Imported ${total} holding${total === 1 ? '' : 's'}`);
    await finalize();
  };

  const removedCount = rows.length - activeRows.length;

  // Read-only confirmation: stamp is set, the extracted holdings have
  // already been imported. Placed after every hook call (state / mutation
  // / memo) so the hook order stays stable across renders.
  if (alreadyActed) {
    const when = actionTakenAt instanceof Date ? actionTakenAt : new Date(String(actionTakenAt));
    const whenLabel = Number.isNaN(when.getTime()) ? '' : when.toLocaleString();
    return (
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <CardTitle className="text-sm">Already imported</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            {holdings.length} holding{holdings.length === 1 ? '' : 's'} from this{' '}
            {fileSource === 'statement' ? 'statement' : 'screenshot'} were confirmed and saved
            {whenLabel ? ` on ${whenLabel}` : ''}. Re-importing from the same parse would create
            duplicates, so this action is locked.
          </p>
          <Button variant="outline" size="sm" asChild className="mt-1 h-7 text-xs">
            <a href={V2_ROUTES.holdings}>View holdings</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2 flex-wrap text-xs mt-1">
          {fileSource && (
            <Badge variant="outline">
              {fileSource === 'screenshot' ? 'Screenshot' : 'Bank statement'}
            </Badge>
          )}
          <span className="text-muted-foreground">
            {activeRows.length} holding{activeRows.length === 1 ? '' : 's'} selected
          </span>
          {typeof overallConfidence === 'number' && (
            <Badge variant="secondary">{Math.round(overallConfidence * 100)}% confidence</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((h) => {
          const isUpdate = Boolean(h.holdingId);
          const isMatched = Boolean(h.tokenId);
          return (
            <div
              key={h.clientId}
              className={`flex items-center gap-2 text-sm p-2.5 rounded-md border transition-opacity ${
                h.removed ? 'border-border/50 opacity-40' : 'border-border'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {isMatched && !h.removed ? (
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : (
                    <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
                  )}
                  <span className="font-medium">{h.symbol}</span>
                  {h.name && h.name !== h.symbol && (
                    <span className="text-muted-foreground text-xs truncate">{h.name}</span>
                  )}
                  {isUpdate && !h.removed && (
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 border-blue-500 text-blue-500"
                    >
                      update
                    </Badge>
                  )}
                  {isMatched && !isUpdate && !h.removed && (
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 border-green-500 text-green-500"
                    >
                      new
                    </Badge>
                  )}
                </div>
                {isUpdate && h.existingBalance && !h.removed && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 ml-5">
                    Current: {Number(h.existingBalance).toLocaleString()}
                  </p>
                )}
              </div>

              {!h.removed && (
                <NumericFormat
                  value={h.balance}
                  onValueChange={(v) => setBalance(h.clientId, v.value)}
                  customInput={Input}
                  className="h-7 w-24 text-xs text-right"
                  thousandSeparator=","
                  decimalScale={8}
                  allowNegative={false}
                  disabled={isSaving}
                />
              )}

              {typeof h.confidence === 'number' && (
                <span className="text-[10px] text-muted-foreground w-8 text-right shrink-0">
                  {Math.round(h.confidence * 100)}%
                </span>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => toggleRemove(h.clientId)}
                title={h.removed ? 'Restore' : 'Remove'}
                disabled={isSaving}
              >
                {h.removed ? (
                  <ArrowLeft className="h-3.5 w-3.5" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </Button>
            </div>
          );
        })}

        <div className="flex gap-3 text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
          {newHoldings.length > 0 && (
            <span className="text-green-500">{newHoldings.length} new</span>
          )}
          {updateHoldings.length > 0 && (
            <span className="text-blue-500">{updateHoldings.length} updates</span>
          )}
          {unmatchedHoldings.length > 0 && (
            <span className="text-yellow-500">{unmatchedHoldings.length} unmatched</span>
          )}
          {removedCount > 0 && <span>{removedCount} removed</span>}
        </div>

        <Button
          onClick={handleSave}
          disabled={(newHoldings.length === 0 && updateHoldings.length === 0) || isSaving}
          className="w-full mt-2"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving…
            </>
          ) : (
            `Import ${newHoldings.length + updateHoldings.length} holding${
              newHoldings.length + updateHoldings.length === 1 ? '' : 's'
            }`
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
