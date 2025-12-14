import type { Account } from '@scani/shared';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AccountTypeSelector,
  InstitutionSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

interface EditAccountModalProps {
  account: Account | null;
  isOpen: boolean;
  onClose: () => void;
  onAccountUpdated?: () => void;
}

export function EditAccountModal({
  account,
  isOpen,
  onClose,
  onAccountUpdated,
}: EditAccountModalProps) {
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [editName, setEditName] = useState('');
  const [editTypeId, setEditTypeId] = useState('');
  const [editInstitutionId, setEditInstitutionId] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Fetch account types and institutions
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();

  // Check if account is synced (has walletAddress in metadata)
  const isSynced =
    account?.metadata &&
    typeof account.metadata === 'object' &&
    'walletAddress' in account.metadata;

  // Update account mutation
  const updateAccountMutation = trpc.accounts.update.useMutation({
    onSuccess: () => {
      // Invalidate all account-related queries
      utils.accounts.getAll.invalidate();
      utils.accounts.getById.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Account updated',
        description: 'The account has been successfully updated.',
      });

      onClose();
      onAccountUpdated?.();
    },
    onError: (error) => showError(error, 'Updating account'),
  });

  // Reset edit state when account changes
  useEffect(() => {
    if (account) {
      setEditName(account.name || '');
      setEditTypeId(account.typeId || '');
      setEditInstitutionId(account.institutionId || '');
      setEditDescription(account.description || '');
    }
  }, [account]);

  // Check if there are any changes
  const hasChanges = () => {
    if (!account || !editName?.trim()) return false;
    return (
      editName !== (account.name || '') ||
      editTypeId !== (account.typeId || '') ||
      editInstitutionId !== (account.institutionId || '') ||
      editDescription !== (account.description || '')
    );
  };

  const handleSave = () => {
    if (!account || !editName?.trim()) return;

    const updateData: {
      name?: string;
      typeId?: string;
      institutionId?: string;
      description?: string | null;
    } = {};

    // Only include changed fields
    if (editName !== account.name) {
      updateData.name = editName;
    }
    if (editTypeId !== account.typeId) {
      updateData.typeId = editTypeId;
    }
    if (editInstitutionId !== account.institutionId) {
      updateData.institutionId = editInstitutionId;
    }
    if (editDescription !== (account.description || '')) {
      updateData.description = editDescription || null;
    }

    // Only make request if there are actual changes
    if (Object.keys(updateData).length === 0) {
      onClose();
      return;
    }

    updateAccountMutation.mutate({
      id: account.id,
      data: updateData,
    });
  };

  if (!account) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Account</DialogTitle>
          <DialogDescription>
            Update account details.{' '}
            {isSynced ? 'Note: Institution and type cannot be changed for synced accounts.' : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Account Name */}
          <div>
            <Label htmlFor="name">Account Name</Label>
            <Input
              id="name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Enter account name"
              className="mt-1"
            />
          </div>

          {/* Account Type */}
          <div>
            <Label htmlFor="type">Account Type</Label>
            <div className="mt-1">
              {isSynced ? (
                <div className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm">
                  {accountTypes?.find((t) => t.id === editTypeId)?.name || 'Unknown Type'}
                </div>
              ) : (
                <AccountTypeSelector
                  value={editTypeId}
                  onValueChange={setEditTypeId}
                  accountTypes={accountTypes || []}
                  placeholder="Select account type..."
                />
              )}
            </div>
            {isSynced ? (
              <p className="text-sm text-muted-foreground mt-1">
                Account type cannot be changed for synced accounts
              </p>
            ) : null}
          </div>

          {/* Institution */}
          <div>
            <Label htmlFor="institution">Institution</Label>
            <div className="mt-1">
              {isSynced ? (
                <div className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm">
                  {institutions?.find((i) => i.id === editInstitutionId)?.name ||
                    'Unknown Institution'}
                </div>
              ) : (
                <InstitutionSelector
                  value={editInstitutionId}
                  onValueChange={setEditInstitutionId}
                  institutions={institutions || []}
                  placeholder="Select institution..."
                />
              )}
            </div>
            {isSynced ? (
              <p className="text-sm text-muted-foreground mt-1">
                Institution cannot be changed for synced accounts
              </p>
            ) : null}
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Enter account description"
              className="mt-1"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!hasChanges() || updateAccountMutation.isPending}>
            <Save className="h-4 w-4 mr-2" />
            {updateAccountMutation.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
