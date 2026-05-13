import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Loader2, LogOut, Monitor, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { trpc } from '@/lib/trpc';
import { FiatCurrencySelect } from '../components/shared/FiatCurrencySelect';
import { invalidatePortfolioQueries } from '../hooks/invalidatePortfolioQueries';
import { useJobStatus } from '../hooks/useJobStatus';
import { V2_ROUTES } from '../lib/routes';

export function SettingsPage() {
  const { data: user, isLoading: userLoading } = trpc.users.getCurrent.useQuery();
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const { signOut } = useAuth();

  const [showDeleteAll, setShowDeleteAll] = useState(false);
  // Tracked job id for the in-flight user-data-delete request. While this
  // is set, the Delete button stays disabled and we subscribe to the job's
  // WS updates. On completion we toast + redirect to the dashboard; on
  // failure we surface the error and release the button.
  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const [recomputeJobId, setRecomputeJobId] = useState<string | null>(null);

  const handleSignOut = () => {
    // ProtectedRoute will redirect to /auth on session loss.
    void signOut();
  };

  const deleteAllDataMutation = trpc.users.deleteAllData.useMutation({
    onSuccess: ({ jobId }) => {
      setShowDeleteAll(false);
      setDeleteJobId(jobId);
    },
    onError: (err) => showError(err, 'Deleting data'),
  });

  const deleteJobStatus = useJobStatus(deleteJobId);
  useEffect(() => {
    if (!deleteJobId) return;
    if (deleteJobStatus.state === 'completed') {
      showSuccess('All your data has been deleted');
      setDeleteJobId(null);
      // Nuke every cached query. Without this, TanStack Query happily
      // keeps serving pre-delete rows for the NetWorthChart, holdings
      // list, dashboard totals, /jobs, integrations — all stale until
      // their individual stale-times roll over. `utils.invalidate()`
      // with no args refetches everything active and drops the rest.
      utils.invalidate();
      navigate(V2_ROUTES.dashboard);
    } else if (deleteJobStatus.state === 'failed') {
      showError(new Error(deleteJobStatus.error ?? 'Delete job failed'), 'Deleting data');
      setDeleteJobId(null);
    }
  }, [deleteJobId, deleteJobStatus.state, deleteJobStatus.error, navigate, utils]);

  const isDeleting = deleteAllDataMutation.isPending || deleteJobId !== null;

  // Manual "rebuild the chart cache" trigger — runs the same job the
  // 04:00 UTC cron runs (portfolio-history-backfill, lookback 365),
  // but on demand. Useful after an import or any time the chart looks
  // off; on completion we invalidate the chart queries so the curve
  // reflects the rebuilt rows immediately.
  const recomputeMutation = trpc.portfolio.recomputeHistory.useMutation({
    onSuccess: ({ jobId }) => setRecomputeJobId(jobId),
    onError: (err) => showError(err, 'Recomputing portfolio history'),
  });
  const recomputeJobStatus = useJobStatus(recomputeJobId);
  useEffect(() => {
    if (!recomputeJobId) return;
    if (recomputeJobStatus.state === 'completed') {
      showSuccess('Portfolio history rebuilt');
      setRecomputeJobId(null);
      utils.portfolio.invalidate();
    } else if (recomputeJobStatus.state === 'failed') {
      showError(
        new Error(recomputeJobStatus.error ?? 'Recompute job failed'),
        'Recomputing portfolio history'
      );
      setRecomputeJobId(null);
    }
  }, [recomputeJobId, recomputeJobStatus.state, recomputeJobStatus.error, utils]);
  const isRecomputing = recomputeMutation.isPending || recomputeJobId !== null;

  const updateMutation = trpc.users.updateCurrent.useMutation({
    onSuccess: (_data, variables) => {
      void utils.users.getCurrent.invalidate();
      void utils.users.getBaseCurrency.invalidate();
      // The auto-save effect always submits both `name` and
      // `baseCurrencyId`, so compare against the rendered user
      // state to detect a real currency change rather than a
      // name-only edit (we don't want to refetch every chart
      // every time the user fixes a typo).
      //
      // When it DID change: refetch every query that renders a
      // money value (every dashboard total, holding price, vault,
      // group, etc.). The `user:update` realtime event fired by
      // the API hits other tabs / devices for the same user; this
      // local call is the fast-path for the tab that initiated the
      // change so the user doesn't have to wait for the WS
      // roundtrip. `refetchType: 'all'` so pages the user hasn't
      // navigated to yet are ready when they get there.
      const previousBaseCurrencyId = user?.baseCurrencyId ?? null;
      const nextBaseCurrencyId = variables.baseCurrencyId ?? null;
      if (nextBaseCurrencyId !== previousBaseCurrencyId) {
        void invalidatePortfolioQueries(utils, { refetchType: 'all' });
      }
    },
  });

  const [name, setName] = useState('');
  const [baseCurrencyId, setBaseCurrencyId] = useState('');

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setBaseCurrencyId(user.baseCurrencyId || '');
    }
  }, [user]);

  const isDirty = useMemo(() => {
    if (!user) return false;
    return name !== (user.name || '') || baseCurrencyId !== (user.baseCurrencyId || '');
  }, [user, name, baseCurrencyId]);

  // Auto-save on change with debounce
  useEffect(() => {
    if (!isDirty || !user) return;
    const timer = setTimeout(() => {
      updateMutation.mutate({
        name: name || undefined,
        baseCurrencyId: baseCurrencyId || undefined,
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [name, baseCurrencyId, isDirty, updateMutation.mutate, user]);

  if (userLoading) {
    return (
      <div className="max-w-2xl space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage your preferences</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={user?.email || ''} disabled className="bg-muted" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currency">Base Currency</Label>
            <FiatCurrencySelect id="currency" value={baseCurrencyId} onChange={setBaseCurrencyId} />
          </div>
        </CardContent>
      </Card>

      {updateMutation.isPending && <p className="text-xs text-muted-foreground">Saving...</p>}
      {isDirty && !updateMutation.isPending && (
        <p className="text-xs text-muted-foreground">Changes will auto-save</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={handleSignOut}
            className="text-red-600 hover:text-red-600 hover:bg-red-600/10"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </CardContent>
      </Card>

      <SessionsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Portfolio history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Rebuild the cached daily values that feed the Net worth and PnL charts. Runs the same
            365-day backfill as the nightly cron — useful after an import or if a chart looks off.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => recomputeMutation.mutate()}
            disabled={isRecomputing}
          >
            {isRecomputing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            {isRecomputing ? 'Rebuilding…' : 'Recompute portfolio history'}
          </Button>
        </CardContent>
      </Card>

      <DataQualityCard />

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Permanently delete all your financial data including accounts, holdings, wallets,
            integration credentials, groups, and vaults. Your account will remain active but empty.
          </p>
          <Button
            type="button"
            variant="destructive"
            onClick={() => setShowDeleteAll(true)}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {isDeleting ? 'Deleting...' : 'Delete all my data'}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showDeleteAll}
        onOpenChange={setShowDeleteAll}
        title="Delete all your data?"
        description="This will permanently delete all your accounts, holdings, wallets, integration credentials, groups, and vaults. This action cannot be undone. Your account will remain active but completely empty."
        confirmLabel="Delete everything"
        cancelLabel="Keep my data"
        variant="destructive"
        isPending={isDeleting}
        onConfirm={() => deleteAllDataMutation.mutate({ requestId: crypto.randomUUID() })}
      />
    </div>
  );
}

/**
 * "Devices & sessions" card.
 *
 * Surfaces the user's active Better-Auth sessions so they can audit
 * other devices and revoke any they don't recognize. The current device
 * is flagged and its revoke control disabled (the standard Sign out
 * button above already covers logging out *here*).
 */
function SessionsCard() {
  const utils = trpc.useUtils();
  const sessionsQuery = trpc.sessions.list.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const revokeMutation = trpc.sessions.revoke.useMutation({
    onSuccess: () => {
      showSuccess('Session revoked');
      utils.sessions.list.invalidate();
    },
    onError: (err) => showError(err, 'Revoking session'),
  });
  const revokeOthersMutation = trpc.sessions.revokeOthers.useMutation({
    onSuccess: () => {
      showSuccess('Signed out of all other sessions');
      utils.sessions.list.invalidate();
    },
    onError: (err) => showError(err, 'Signing out other sessions'),
  });

  const sessions = sessionsQuery.data ?? [];
  const otherCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Devices &amp; sessions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Active sign-ins on your account. Revoke any device you don't recognize.
        </p>

        {sessionsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Monitor className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {summarizeUserAgent(s.userAgent)}
                      {s.isCurrent && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          (this device)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.ipAddress ?? 'unknown IP'} · last active {formatRelative(s.updatedAt)}
                    </div>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={s.isCurrent || revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate({ token: s.token })}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}

        {otherCount > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={revokeOthersMutation.isPending}
            onClick={() => revokeOthersMutation.mutate()}
          >
            {revokeOthersMutation.isPending
              ? 'Signing out…'
              : `Sign out everywhere else (${otherCount})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Cheap user-agent → "Browser on OS" summary. Avoids pulling in a real
 * UA parser dependency for what's essentially a 6-pattern decision.
 */
function summarizeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

function formatRelative(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} d ago`;
  return date.toLocaleDateString();
}

// Surfaces the data-quality counters that historically only showed up
// in Sentry / DB queries: duplicate token rows, zero-balance visible
// holdings (the cluttered list), unpriced positives, holdings whose
// import flow synthesized a negative opening balance. Lets the user
// spot regressions before the chart goes wrong.
function DataQualityCard() {
  const reportQuery = trpc.portfolio.getDataQualityReport.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  if (reportQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Data quality</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const r = reportQuery.data;
  if (!r) {
    return null;
  }

  const dupCount = r.duplicateTokens.length;
  const rows: Array<{ label: string; value: number; warn: boolean; hint?: string }> = [
    {
      label: 'Duplicate token rows',
      value: dupCount,
      warn: dupCount > 0,
      hint:
        dupCount > 0
          ? r.duplicateTokens
              .slice(0, 5)
              .map((d) => `${d.symbol}×${d.count}`)
              .join(', ')
          : undefined,
    },
    {
      label: 'Holdings (visible / total)',
      value: r.holdings.visible,
      warn: false,
      hint: `${r.holdings.total} total`,
    },
    {
      label: 'Zero-balance visible holdings',
      value: r.holdings.zeroVisible,
      warn: r.holdings.zeroVisible > 5,
    },
    {
      label: `Stale-zero (will hide on next ${r.thresholds.staleClosedDays}d sweep)`,
      value: r.holdings.zeroVisibleStale,
      warn: false,
    },
    {
      label: 'Visible positions with no recent price',
      value: r.holdings.unpricedVisible,
      warn: r.holdings.unpricedVisible > 0,
    },
    {
      label: 'Negative synthesized opening balance',
      value: r.holdings.negativeOpening,
      warn: r.holdings.negativeOpening > 0,
      hint: 'Import didn’t reach back to before the user’s trades',
    },
    {
      label: 'Holdings with no coverage row',
      value: r.holdings.missingCoverage,
      warn: r.holdings.missingCoverage > 0,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Data quality</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Counters update on every page load. Anything in amber is a regression worth investigating.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between rounded-md border border-border/50 px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">{row.label}</span>
                {row.hint ? (
                  <span className="text-[10px] text-muted-foreground/70">{row.hint}</span>
                ) : null}
              </div>
              <span
                className={`tabular-nums text-sm font-medium ${row.warn ? 'text-amber-600' : ''}`}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
