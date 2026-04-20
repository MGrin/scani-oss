import { LogOut, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { ConfirmDialog } from '../components/shared/ConfirmDialog';
import { useJobStatus } from '../hooks/useJobStatus';
import { V2_ROUTES } from '../lib/routes';

export function SettingsPage() {
  const { data: user, isLoading: userLoading } = trpc.users.getCurrent.useQuery();
  const { data: currencies } = trpc.users.getSupportedCurrencies.useQuery();
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
            <Select value={baseCurrencyId} onValueChange={setBaseCurrencyId}>
              <SelectTrigger id="currency">
                <SelectValue placeholder="Select currency" />
              </SelectTrigger>
              <SelectContent>
                {currencies?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.symbol} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
