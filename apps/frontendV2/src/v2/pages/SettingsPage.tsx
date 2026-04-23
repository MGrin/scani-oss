import { LogOut, Monitor, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { ConfirmDialog } from '../components/shared/ConfirmDialog';
import { FiatCurrencySelect } from '../components/shared/FiatCurrencySelect';
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
      navigate(V2_ROUTES.dashboard);
    } else if (deleteJobStatus.state === 'failed') {
      showError(new Error(deleteJobStatus.error ?? 'Delete job failed'), 'Deleting data');
      setDeleteJobId(null);
    }
  }, [deleteJobId, deleteJobStatus.state, deleteJobStatus.error, navigate]);

  const isDeleting = deleteAllDataMutation.isPending || deleteJobId !== null;

  const updateMutation = trpc.users.updateCurrent.useMutation({
    onSuccess: () => {
      utils.users.getCurrent.invalidate();
      utils.users.getBaseCurrency.invalidate();
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
