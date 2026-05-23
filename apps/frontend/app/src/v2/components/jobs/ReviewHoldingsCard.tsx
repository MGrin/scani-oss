import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { showError } from '@scani/ui/ui/use-toast';
import { ArrowLeft, Check, CheckCircle2, Loader2, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../../lib/routes';
import { TokenSearchInput } from '../tokens/TokenSearchInput';

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
  /** AI-classified asset type (fiat / crypto / stock), when available. */
  assetType?: 'fiat' | 'crypto' | 'stock' | null;
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

  // Read-only latch: once the job's `action_taken_at` is set, we render
  // a compact confirmation instead of the editable review table. Stamp
  // is set server-side by the manual-holdings-create worker after the
  // import succeeds — no frontend write path here.
  const alreadyActed = Boolean(actionTakenAt);

  const [rows, setRows] = useState<Row[]>(() => holdings.map(makeRow));

  // Per-row "change token" mode. AI extraction can mismatch
  // (e.g. fiat USD getting matched against a stock ETF named "USD"),
  // so each row carries an inline TokenSearchInput when active. Set
  // to clientId of the row being edited; null = none active.
  const [editingClientId, setEditingClientId] = useState<string | null>(null);

  // Single mutation drives both create + balance-update. Worker stamps
  // the parent (screenshot/file-import) job's actionTakenAt only on
  // success, so a failed import leaves the review re-runnable.
  const createBatchMutation = trpc.batchOperations.createHoldingsBatch.useMutation({
    onError: (err) => showError(err, 'Saving holdings'),
    onSuccess: ({ jobId: newJobId }) => {
      navigate(V2_ROUTES.jobDetail(newJobId));
    },
  });

  const isSaving = createBatchMutation.isPending;

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

  // Replace the matched token on a row (re-pointing tokenId/symbol/name).
  // Clears the holdingId so an existing-balance update flips back to a
  // fresh create — the previous holdingId belongs to a different token.
  const swapToken = (clientId: string, tokenId: string, symbol: string, name: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.clientId === clientId
          ? { ...r, tokenId, symbol, name, holdingId: null, existingBalance: null }
          : r
      )
    );
    setEditingClientId(null);
  };

  const handleSave = () => {
    const toUpdate = updateHoldings.filter((h) => h.holdingId && h.balance);
    const toCreate = newHoldings.filter((h) => h.tokenId && h.balance);

    if (toCreate.length === 0 && toUpdate.length === 0) {
      showError('No valid holdings to import', 'Import');
      return;
    }

    createBatchMutation.mutate({
      requestId: crypto.randomUUID(),
      accountId,
      newHoldings: toCreate.map((h) => ({
        tokenId: h.tokenId as string,
        balance: h.balance,
      })),
      updateHoldings: toUpdate.map((h) => ({
        holdingId: h.holdingId as string,
        balance: h.balance,
      })),
      parentJobIdToStampOnSuccess: jobId,
    });
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
              className={`flex flex-col sm:flex-row sm:items-center gap-2 text-sm p-2.5 rounded-md border transition-opacity ${
                h.removed ? 'border-border/50 opacity-40' : 'border-border'
              }`}
            >
              <div className="min-w-0 flex-1">
                {editingClientId === h.clientId ? (
                  <div className="flex items-center gap-2 w-full">
                    <div className="flex-1 min-w-0">
                      <TokenSearchInput
                        value={null}
                        onSelect={(id, _label, details) =>
                          swapToken(
                            h.clientId,
                            id,
                            details?.symbol ?? h.symbol,
                            details?.name ?? ''
                          )
                        }
                        onClear={() => setEditingClientId(null)}
                        disabled={isSaving}
                        placeholder={`Find a different token (was ${h.symbol})`}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs shrink-0"
                      onClick={() => setEditingClientId(null)}
                      disabled={isSaving}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {isMatched && !h.removed ? (
                      <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
                    )}
                    <span className="font-medium shrink-0">{h.symbol}</span>
                    {h.name && h.name !== h.symbol && (
                      <span className="text-muted-foreground text-xs truncate min-w-0">
                        {h.name}
                      </span>
                    )}
                    {h.assetType && (
                      <Badge
                        variant="secondary"
                        className="text-[9px] px-1 py-0 capitalize shrink-0"
                      >
                        {h.assetType}
                      </Badge>
                    )}
                    {isUpdate && !h.removed && (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 border-blue-500 text-blue-500 shrink-0"
                      >
                        update
                      </Badge>
                    )}
                    {isMatched && !isUpdate && !h.removed && (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 border-green-500 text-green-500 shrink-0"
                      >
                        new
                      </Badge>
                    )}
                    {!h.removed && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setEditingClientId(h.clientId)}
                        title="Change token"
                        disabled={isSaving}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                )}
                {isUpdate && h.existingBalance && !h.removed && editingClientId !== h.clientId && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 ml-5">
                    Current: {Number(h.existingBalance).toLocaleString()}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {!h.removed && (
                  <NumericFormat
                    value={h.balance}
                    onValueChange={(v) => setBalance(h.clientId, v.value)}
                    customInput={Input}
                    className="h-9 flex-1 sm:flex-none sm:w-28 text-xs text-right"
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
