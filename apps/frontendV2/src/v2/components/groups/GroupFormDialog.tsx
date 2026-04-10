import { ArrowLeft, ArrowRight } from 'lucide-react';
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

type Step = 1 | 2 | 3;

export function GroupFormDialog({ open, onOpenChange, groupId }: GroupFormDialogProps) {
  const utils = trpc.useUtils();
  const { data: groups } = trpc.groups.getAllWithCounts.useQuery();
  const { data: holdingsData } = trpc.holdings.getWithDetails.useQuery();
  const { data: accountsData } = trpc.accounts.getByUserIdWithSummary.useQuery();
  const group = groupId ? groups?.find((g) => g.id === groupId) : null;

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [holdingSearch, setHoldingSearch] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [selectedHoldingIds, setSelectedHoldingIds] = useState<Set<string>>(new Set());
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());

  const holdings = holdingsData?.holdings ?? [];
  const accounts = accountsData ?? [];

  // Initialize from existing group data
  useEffect(() => {
    if (!open) return;
    if (group) {
      setName(group.name);
      setDescription(group.description || '');
      setColor(group.color);
      const hIds = new Set<string>();
      for (const h of holdings) {
        if (h.groups.some((g) => g.id === groupId)) hIds.add(h.id);
      }
      setSelectedHoldingIds(hIds);
      const aIds = new Set<string>();
      for (const a of accounts) {
        if (a.groups.some((g) => g.id === groupId)) aIds.add(a.id);
      }
      setSelectedAccountIds(aIds);
    } else {
      setName('');
      setDescription('');
      setColor(COLORS[Math.floor(Math.random() * COLORS.length)]!);
      setSelectedHoldingIds(new Set());
      setSelectedAccountIds(new Set());
    }
    setStep(1);
    setHoldingSearch('');
    setAccountSearch('');
  }, [open, group, groupId, holdings, accounts]);

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
      const groupIds = [newGroup.id];
      if (selectedHoldingIds.size > 0) {
        assignHoldingsMutation.mutate({ holdingIds: Array.from(selectedHoldingIds), groupIds });
      }
      if (selectedAccountIds.size > 0) {
        assignAccountsMutation.mutate({ accountIds: Array.from(selectedAccountIds), groupIds });
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
    onError: (error) => showError(error, 'Assigning holdings'),
  });
  const assignAccountsMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onError: (error) => showError(error, 'Assigning accounts'),
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
  const stepTitle = step === 1 ? 'Details' : step === 2 ? 'Select Accounts' : 'Select Holdings';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {groupId ? 'Edit Group' : 'New Group'}
              <span className="text-muted-foreground font-normal text-sm ml-2">— {stepTitle}</span>
            </DialogTitle>
            {/* Step indicator */}
            <div className="flex gap-1 pt-2">
              {[1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    s <= step ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              ))}
            </div>
          </DialogHeader>

          {/* Step 1: Details */}
          {step === 1 && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="group-name">Name</Label>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Group name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="group-desc">Description</Label>
                <Textarea
                  id="group-desc"
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

          {/* Step 2: Accounts */}
          {step === 2 && (
            <div className="space-y-2 py-2">
              <p className="text-xs text-muted-foreground">
                Select accounts to include in this group ({selectedAccountIds.size} selected)
              </p>
              <Input
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                placeholder="Search accounts..."
                className="h-8 text-xs"
              />
              <div className="max-h-[280px] overflow-y-auto space-y-px rounded-md border border-border p-1">
                {filteredAccounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-2 rounded-sm hover:bg-accent text-left text-sm"
                    onClick={() => toggleAccount(a.id)}
                  >
                    <Checkbox checked={selectedAccountIds.has(a.id)} className="h-3.5 w-3.5" />
                    <span className="font-medium truncate flex-1">{a.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {a.summary.holdingsCount} holdings
                    </span>
                  </button>
                ))}
                {filteredAccounts.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    No accounts found
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Holdings */}
          {step === 3 && (
            <div className="space-y-2 py-2">
              <p className="text-xs text-muted-foreground">
                Select holdings to include in this group ({selectedHoldingIds.size} selected)
              </p>
              <Input
                value={holdingSearch}
                onChange={(e) => setHoldingSearch(e.target.value)}
                placeholder="Search holdings..."
                className="h-8 text-xs"
              />
              <div className="max-h-[280px] overflow-y-auto space-y-px rounded-md border border-border p-1">
                {filteredHoldings.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-2 rounded-sm hover:bg-accent text-left text-sm"
                    onClick={() => toggleHolding(h.id)}
                  >
                    <Checkbox checked={selectedHoldingIds.has(h.id)} className="h-3.5 w-3.5" />
                    <span className="font-medium w-12 shrink-0">{h.token.symbol}</span>
                    <span className="text-xs text-muted-foreground truncate flex-1">
                      {h.token.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {h.institution.name}
                    </span>
                  </button>
                ))}
                {filteredHoldings.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    No holdings found
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
            <div className="flex gap-2">
              {groupId && step === 1 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleteMutation.isPending}
                >
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2 ml-auto">
              {step > 1 && (
                <Button variant="outline" size="sm" onClick={() => setStep((s) => (s - 1) as Step)}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                  Back
                </Button>
              )}
              {step === 1 && (
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              )}
              {step < 3 ? (
                <Button
                  size="sm"
                  onClick={() => setStep((s) => (s + 1) as Step)}
                  disabled={step === 1 && !name.trim()}
                >
                  Next
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              ) : (
                <Button size="sm" onClick={handleSubmit} disabled={!name.trim() || isPending}>
                  {groupId ? 'Save' : 'Create'}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {groupId && (
        <ConfirmDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
          title="Delete Group"
          description={`Are you sure you want to delete "${group?.name || 'this group'}"?`}
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={() => deleteMutation.mutate({ id: groupId })}
        />
      )}
    </>
  );
}
