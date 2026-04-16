import { AlertTriangle, ArrowLeft, Check, Loader2, Search, Trash2, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

type Step = 'input' | 'detecting' | 'detected' | 'importing' | 'result';

export function WalletImportPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [step, setStep] = useState<Step>('input');
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Track holdings the user has already reviewed (deleted or marked as scam)
  // in the post-import review screen, so they disappear from the list
  // without requiring a refetch of the imported data.
  const [reviewedHoldingIds, setReviewedHoldingIds] = useState<Set<string>>(new Set());

  const detectMutation = trpc.wallet.detectChains.useMutation({
    onSuccess: (data) => {
      // Auto-fill displayName with ENS name if the user hasn't provided one
      if (data.ensName && !displayName.trim()) {
        setDisplayName(data.ensName);
      }
      setStep('detected');
    },
    onError: (err) => {
      showError(err, 'Detecting chains');
      setStep('input');
    },
  });

  const importMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: async (result) => {
      setStep('result');
      setReviewedHoldingIds(new Set());
      // Force-invalidate every list/aggregate the new wallet's holdings
      // can appear on. `refetchType: 'all'` is critical: without it,
      // inactive observers (the Holdings list page the user may navigate
      // to via "View Holdings") are only marked stale and never refetched,
      // because React Query's `refetchOnMount: false` then serves the
      // pre-mutation cache on arrival.
      await Promise.all([
        utils.holdings.getWithDetails.invalidate(undefined, { refetchType: 'all' }),
        utils.accounts.getAll.invalidate(undefined, { refetchType: 'all' }),
        utils.accounts.getByUserIdWithSummary.invalidate(undefined, { refetchType: 'all' }),
        utils.institutions.getByUserId.invalidate(undefined, { refetchType: 'all' }),
        utils.institutions.getByUserIdWithSummary.invalidate(undefined, { refetchType: 'all' }),
        utils.dashboard.getOverview.invalidate(undefined, { refetchType: 'all' }),
        utils.dashboard.getAssetAllocation.invalidate(undefined, { refetchType: 'all' }),
      ]);
      showSuccess(
        `Imported ${result.holdings?.length ?? 0} holdings across ${result.accounts?.length ?? 0} accounts`
      );
    },
    onError: (err) => {
      showError(err, 'Importing wallet');
      setStep('detected');
    },
  });

  // Delete (soft-delete — sets isHidden=true) the user's own holding.
  const deleteHoldingMutation = trpc.holdings.delete.useMutation({
    onError: (err) => showError(err, 'Deleting holding'),
  });

  // Flag a token as scam across the system. Only offered for tokens that
  // this import was the first to introduce to the system.
  const markTokenAsScamMutation = trpc.tokens.markAsScam.useMutation({
    onError: (err) => showError(err, 'Marking token as scam'),
  });

  const handleDeleteHolding = async (holdingId: string) => {
    try {
      await deleteHoldingMutation.mutateAsync({ id: holdingId });
      setReviewedHoldingIds((prev) => new Set(prev).add(holdingId));
      showSuccess('Holding removed');
    } catch {
      // Error already surfaced via onError toast.
    }
  };

  const handleMarkAsScam = async (holdingId: string, tokenId: string, tokenSymbol: string) => {
    try {
      // Order matters: mark scam first (global classification), then remove
      // the user's own holding. If the scam-mark fails we don't delete.
      await markTokenAsScamMutation.mutateAsync({ tokenId });
      await deleteHoldingMutation.mutateAsync({ id: holdingId });
      setReviewedHoldingIds((prev) => new Set(prev).add(holdingId));
      showSuccess(`${tokenSymbol} marked as scam and removed from your portfolio`);
    } catch {
      // Error already surfaced via onError toast.
    }
  };

  const handleDetect = () => {
    if (!address.trim()) return;
    setStep('detecting');
    detectMutation.mutate({ address: address.trim() });
  };

  const handleImport = () => {
    setStep('importing');
    importMutation.mutate({
      address: address.trim(),
      displayName: displayName.trim() || undefined,
    });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={V2_ROUTES.addData}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Add Data
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">Import Crypto Wallet</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Enter a wallet address to auto-detect chains and import balances
        </p>
      </div>

      {/* Step 1: Input */}
      {step === 'input' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Wallet Address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x... or bc1... or any blockchain address"
              className="font-mono text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleDetect();
              }}
            />
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (optional)"
            />
            <Button onClick={handleDetect} disabled={!address.trim()}>
              <Search className="h-4 w-4 mr-2" />
              Detect Chains
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Detecting */}
      {step === 'detecting' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">Detecting blockchain chains...</p>
            <p className="text-xs text-muted-foreground mt-1">
              Scanning supported networks for activity at this address
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Detected */}
      {step === 'detected' && detectMutation.data && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detected Chains</CardTitle>
            </CardHeader>
            <CardContent>
              {detectMutation.data.chainsDetected?.length > 0 ? (
                <div className="space-y-2">
                  {detectMutation.data.ensName && (
                    <p className="text-sm text-muted-foreground">
                      ENS name resolved:{' '}
                      <span className="font-medium text-foreground">
                        {detectMutation.data.ensName}
                      </span>
                    </p>
                  )}
                  {detectMutation.data.chainsDetected.map((chain) => (
                    <div
                      key={String(chain.chainId)}
                      className="flex items-center gap-2 p-2 rounded-md border border-border"
                    >
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                      <span className="font-medium text-sm">{chain.name}</span>
                      <Badge variant="secondary" className="text-[10px] ml-auto">
                        {chain.type}
                      </Badge>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground mt-2">
                    {detectMutation.data.chainsDetected.length} chain(s) found. Click "Import" to
                    fetch all balances.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No supported chains detected for this address.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button onClick={handleImport} disabled={!detectMutation.data.chainsDetected?.length}>
              Import Balances
            </Button>
            <Button variant="outline" onClick={() => setStep('input')}>
              Change Address
            </Button>
          </div>
        </div>
      )}

      {/* Step 4: Importing */}
      {step === 'importing' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">Importing wallet balances...</p>
            <p className="text-xs text-muted-foreground mt-1">
              Fetching balances from all detected chains. This may take a moment.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step 5: Result */}
      {step === 'result' && importMutation.data && (
        <ResultStep
          data={importMutation.data}
          reviewedHoldingIds={reviewedHoldingIds}
          onDelete={handleDeleteHolding}
          onMarkAsScam={handleMarkAsScam}
          onViewHoldings={() => navigate(V2_ROUTES.holdings)}
          onImportAnother={() => {
            setStep('input');
            setAddress('');
            setDisplayName('');
            setReviewedHoldingIds(new Set());
          }}
          isBusy={deleteHoldingMutation.isPending || markTokenAsScamMutation.isPending}
        />
      )}
    </div>
  );
}

// ── Result Step ────────────────────────────────────────────────────────────

type ImportResult = NonNullable<ReturnType<typeof trpc.wallet.importAddress.useMutation>['data']>;
type ImportedHolding = ImportResult['holdings'][number];

interface ResultStepProps {
  data: ImportResult;
  reviewedHoldingIds: Set<string>;
  onDelete: (holdingId: string) => void;
  onMarkAsScam: (holdingId: string, tokenId: string, tokenSymbol: string) => void;
  onViewHoldings: () => void;
  onImportAnother: () => void;
  isBusy: boolean;
}

const SCAM_PROBABILITY_THRESHOLD = 0.35;

function ResultStep({
  data,
  reviewedHoldingIds,
  onDelete,
  onMarkAsScam,
  onViewHoldings,
  onImportAnother,
  isBusy,
}: ResultStepProps) {
  // Filter out likely-scam tokens, then group visible holdings by chain,
  // preserving the server-side order within each group.
  const { grouped, visibleCount, scamHiddenCount } = useMemo(() => {
    const map = new Map<string, ImportedHolding[]>();
    let visible = 0;
    let scamHidden = 0;
    for (const h of data.holdings) {
      if (reviewedHoldingIds.has(h.id)) continue;
      if (h.tokenScamProbability >= SCAM_PROBABILITY_THRESHOLD) {
        scamHidden++;
        continue;
      }
      visible++;
      const key = h.chainName || 'Unknown chain';
      const list = map.get(key) ?? [];
      list.push(h);
      map.set(key, list);
    }
    return {
      grouped: Array.from(map.entries()),
      visibleCount: visible,
      scamHiddenCount: scamHidden,
    };
  }, [data.holdings, reviewedHoldingIds]);

  const newTokenCount = data.holdings.filter(
    (h) =>
      h.tokenIsNew &&
      !reviewedHoldingIds.has(h.id) &&
      h.tokenScamProbability < SCAM_PROBABILITY_THRESHOLD
  ).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6 text-center">
          <Wallet className="h-10 w-10 mx-auto text-green-500 mb-3" />
          <h3 className="text-lg font-semibold">Import Complete</h3>
          {data.walletLabel && <p className="text-sm font-medium mt-1">{data.walletLabel}</p>}
          <p className="text-sm text-muted-foreground mt-1">
            {data.accounts?.length ?? 0} account
            {data.accounts?.length === 1 ? '' : 's'} and {visibleCount} holding
            {visibleCount === 1 ? '' : 's'} imported
          </p>
          {scamHiddenCount > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {scamHiddenCount} likely-scam token{scamHiddenCount === 1 ? '' : 's'} auto-hidden
            </p>
          )}
          {newTokenCount > 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              {newTokenCount} previously-unknown token
              {newTokenCount === 1 ? '' : 's'} — review below
            </p>
          )}
          {data.errors && data.errors.length > 0 && (
            <div className="mt-3 text-left">
              <p className="text-xs font-medium text-destructive mb-1">Errors:</p>
              {data.errors.map((err) => (
                <p key={`${err.chainId}-${err.error}`} className="text-xs text-muted-foreground">
                  {err.chainName}: {err.error}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {visibleCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review Imported Holdings</CardTitle>
            <p className="text-xs text-muted-foreground">
              Delete any unwanted holdings. Tokens new to our system can be flagged as scam to help
              improve detection for everyone.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {grouped.map(([chainName, holdings]) => (
              <div key={chainName} className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {chainName}
                </p>
                <div className="space-y-1.5">
                  {holdings.map((h) => (
                    <HoldingReviewRow
                      key={h.id}
                      holding={h}
                      onDelete={() => onDelete(h.id)}
                      onMarkAsScam={() => onMarkAsScam(h.id, h.tokenId, h.tokenSymbol)}
                      disabled={isBusy}
                    />
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {visibleCount === 0 && data.holdings.length - scamHiddenCount > 0 && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            All imported holdings were reviewed. Nothing left to process.
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3">
        <Button onClick={onViewHoldings}>View Holdings</Button>
        <Button variant="outline" onClick={onImportAnother}>
          Import Another
        </Button>
      </div>
    </div>
  );
}

function HoldingReviewRow({
  holding,
  onDelete,
  onMarkAsScam,
  disabled,
}: {
  holding: ImportedHolding;
  onDelete: () => void;
  onMarkAsScam: () => void;
  disabled: boolean;
}) {
  // Format balance: up to 6 significant digits, drop trailing zeros.
  const formattedBalance = formatBalance(holding.balance);

  // Compute value in base currency if price is available
  const formattedValue = useMemo(() => {
    if (!holding.priceInBaseCurrency) return null;
    const balance = Number(holding.balance);
    const price = Number(holding.priceInBaseCurrency);
    if (!Number.isFinite(balance) || !Number.isFinite(price)) return null;
    const value = balance * price;
    if (value < 0.01) return null;
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }, [holding.balance, holding.priceInBaseCurrency]);

  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-2.5">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {holding.tokenIconUrl ? (
          <img
            src={holding.tokenIconUrl}
            alt=""
            className="h-5 w-5 rounded-full object-contain shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="h-5 w-5 rounded-full bg-muted shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-sm">{holding.tokenSymbol}</span>
            {holding.tokenIsNew && (
              <Badge
                variant="secondary"
                className="text-[9px] bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
              >
                New token
              </Badge>
            )}
          </div>
          {holding.tokenName && holding.tokenName !== holding.tokenSymbol && (
            <p className="text-xs text-muted-foreground truncate">{holding.tokenName}</p>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <span className="text-sm font-mono tabular-nums">{formattedBalance}</span>
        {formattedValue && (
          <p className="text-[11px] text-muted-foreground tabular-nums">{formattedValue}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {holding.tokenIsNew && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px] text-red-600 hover:text-red-600 hover:bg-red-600/10 border-red-600/40"
            onClick={onMarkAsScam}
            disabled={disabled}
            title="Mark this token as scam across the system and remove from your portfolio"
          >
            <AlertTriangle className="h-3 w-3 mr-1" />
            Mark scam
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          disabled={disabled}
          title="Remove this holding from your portfolio"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function formatBalance(raw: string): string {
  // The backend stores balance as a decimal string. For display we parse
  // and format — the rest of the app uses Decimal.js, but for a simple
  // review row this is enough. If parseFloat fails we show the raw string.
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n === 0) return '0';
  if (n < 0.000001) return n.toExponential(2);
  // Up to 6 significant digits, trim trailing zeros.
  return n
    .toPrecision(6)
    .replace(/\.?0+$/, '')
    .replace(/(\.\d*[1-9])0+$/, '$1');
}
