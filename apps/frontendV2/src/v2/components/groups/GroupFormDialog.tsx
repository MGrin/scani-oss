import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { ConfirmDialog } from '../shared/ConfirmDialog';

const COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

interface GroupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string | null;
}

type Tab = 'details' | 'holdings' | 'accounts';

export function GroupFormDialog({ open, onOpenChange, groupId }: GroupFormDialogProps) {
  const utils = trpc.useUtils();
  const { data: groups } = trpc.groups.getAllWithCounts.useQuery();
  const { data: holdingsData } = trpc.holdings.getWithDetails.useQuery();
  const { data: accountsData } = trpc.accounts.getByUserIdWithSummary.useQuery();
  const group = groupId ? groups?.find((g) => g.id === groupId) : null;

  const [tab, setTab] = useState<Tab>('details');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [holdingSearch, setHoldingSearch] = useState('');
  const [accountSearch, setAccountSearch] = useState('');

  // Track which holdings/accounts are in this group
  const [selectedHoldingIds, setSelectedHoldingIds] = useState<Set<string>>(new Set());
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());

  const holdings = holdingsData?.holdings ?? [];
  const accounts = accountsData ?? [];

  // Initialize from existing group data
  useEffect(() => {
    if (group) {
      setName(group.name);
      setDescription(group.description || '');
      setColor(group.color);
      // Pre-select holdings that are in this group
      const hIds = new Set<string>();
      for (const h of holdings) {
        if (h.groups.some((g) => g.id === groupId)) {
          hIds.add(h.id);
        }
      }
      setSelectedHoldingIds(hIds);
      // Pre-select accounts
      const aIds = new Set<string>();
      for (const a of accounts) {
        if (a.groups.some((g) => g.id === groupId)) {
          aIds.add(a.id);
        }
      }
      setSelectedAccountIds(aIds);
    } else {
      setName('');
      setDescription('');
      setColor(COLORS[Math.floor(Math.random() * COLORS.length)]!);
      setSelectedHoldingIds(new Set());
      setSelectedAccountIds(new Set());
    }
    setTab('details');
  }, [group, groupId, holdings, accounts]);

  const filteredHoldings = useMemo(() => {
    if (!holdingSearch) return holdings;
    const q = holdingSearch.toLowerCase();
    return holdings.filter(
      (h) =>
        h.token.symbol.toLowerCase().includes(q) ||
        h.token.name.toLowerCase().includes(q) ||
        h.institution.name.toLowerCase().includes(q)
    );
  }, [holdings, holdingSearch]);

  const filteredAccounts = useMemo(() => {
    if (!accountSearch) return accounts;
    const q = accountSearch.toLowerCase();
    return accounts.filter((a) => a.name.toLowerCase().includes(q));
  }, [accounts, accountSearch]);

  const toggleHolding = (id: string) => {
    setSelectedHoldingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createMutation = trpc.groups.create.useMutation({
    onSuccess: (newGroup) => {
      // Assign holdings and accounts to the new group
      const groupIds = [newGroup.id];
      if (selectedHoldingIds.size > 0) {
        assignHoldingsMutation.mutate({
          holdingIds: Array.from(selectedHoldingIds),
          groupIds,
        });
      }
      if (selectedAccountIds.size > 0) {
        assignAccountsMutation.mutate({
          accountIds: Array.from(selectedAccountIds),
          groupIds,
        });
      }
      utils.groups.invalidate();
      utils.holdings.invalidate();
      utils.accounts.invalidate();
      onOpenChange(false);
      showSuccess('Group created');
    },
    onError: (error) => showError(error, 'Creating group'),
  });

  const updateMutation = trpc.groups.update.useMutation({
    onSuccess: () => {
      // Re-assign holdings and accounts
      if (groupId) {
        assignHoldingsMutation.mutate({
          holdingIds: Array.from(selectedHoldingIds),
          groupIds: [groupId],
        });
        assignAccountsMutation.mutate({
          accountIds: Array.from(selectedAccountIds),
          groupIds: [groupId],
        });
      }
      utils.groups.invalidate();
      utils.holdings.invalidate();
      utils.accounts.invalidate();
      onOpenChange(false);
      showSuccess('Group updated');
    },
    onError: (error) => showError(error, 'Updating group'),
  });

  const deleteMutation = trpc.groups.delete.useMutation({
    onSuccess: () => {
      utils.groups.invalidate();
      onOpenChange(false);
      showSuccess('Group deleted');
    },
    onError: (error) => showError(error, 'Deleting group'),
  });

  const assignHoldingsMutation = trpc.holdings.bulkAssignGroups.useMutation({
    onError: (error) => showError(error, 'Assigning holdings to group'),
  });

  const assignAccountsMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onError: (error) => showError(error, 'Assigning accounts to group'),
  });

  const handleSubmit = () => {
    if (!name.trim()) return;
    const descValue = description.trim() || null;
    if (groupId) {
      updateMutation.mutate({
        id: groupId,
        data: { name: name.trim(), color, description: descValue },
      });
    } else {
      createMutation.mutate({ name: name.trim(), color, description: descValue });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{groupId ? 'Edit Group' : 'New Group'}</DialogTitle>
          </DialogHeader>

          {/* Tabs */}
          <div className="flex border-b border-border -mx-6 px-6">
            {(['details', 'holdings', 'accounts'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm capitalize border-b-2 transition-colors ${
                  tab === t
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t}
                {t === 'holdings' && selectedHoldingIds.size > 0 && (
                  <span className="ml-1 text-xs text-primary">({selectedHoldingIds.size})</span>
                )}
                {t === 'accounts' && selectedAccountIds.size > 0 && (
                  <span className="ml-1 text-xs text-primary">({selectedAccountIds.size})</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto py-2 min-h-[200px]">
            {/* Details tab */}
            {tab === 'details' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="group-name">Name</Label>
                  <Input
                    id="group-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Group name"
                    onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="group-description">Description</Label>
                  <Textarea
                    id="group-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                    maxLength={200}
                    rows={2}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Color</Label>
                  <div className="flex gap-2 flex-wrap">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
                        style={{
                          backgroundColor: c,
                          borderColor: color === c ? 'var(--foreground)' : 'transparent',
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Holdings tab */}
            {tab === 'holdings' && (
              <div className="space-y-2">
                <Input
                  value={holdingSearch}
                  onChange={(e) => setHoldingSearch(e.target.value)}
                  placeholder="Search holdings..."
                  className="h-8 text-xs"
                />
                <div className="space-y-px">
                  {filteredHoldings.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm hover:bg-accent text-left text-sm"
                      onClick={() => toggleHolding(h.id)}
                    >
                      <Checkbox checked={selectedHoldingIds.has(h.id)} className="h-3.5 w-3.5" />
                      <span className="font-medium">{h.token.symbol}</span>
                      <span className="text-xs text-muted-foreground truncate flex-1">
                        {h.token.name}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {h.institution.name}
                      </span>
                    </button>
                  ))}
                  {filteredHoldings.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      No holdings found
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Accounts tab */}
            {tab === 'accounts' && (
              <div className="space-y-2">
                <Input
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="Search accounts..."
                  className="h-8 text-xs"
                />
                <div className="space-y-px">
                  {filteredAccounts.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm hover:bg-accent text-left text-sm"
                      onClick={() => toggleAccount(a.id)}
                    >
                      <Checkbox checked={selectedAccountIds.has(a.id)} className="h-3.5 w-3.5" />
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {a.summary.holdingsCount} holdings
                      </span>
                    </button>
                  ))}
                  {filteredAccounts.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      No accounts found
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-row justify-between sm:justify-between">
            {groupId && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={deleteMutation.isPending}
              >
                Delete
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!name.trim() || isPending}>
                {groupId ? 'Save' : 'Create'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {groupId && (
        <ConfirmDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
          title="Delete Group"
          description={`Are you sure you want to delete "${group?.name || 'this group'}"? This action cannot be undone.`}
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={() => deleteMutation.mutate({ id: groupId })}
        />
      )}
    </>
  );
}
