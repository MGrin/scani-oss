import { Button } from '@scani/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { type RouterOutputs, trpc } from '@/lib/trpc';

type Vendor = RouterOutputs['vendors']['list'][number];

interface VendorMergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The vendor being viewed — pre-selected as the merge target ("into"). */
  vendor: Vendor;
  vendors: Vendor[];
  onMerged?: () => void;
}

/**
 * Manual vendor merge: folds a duplicate ("from") into the vendor being
 * viewed ("into"). `intoId` is fixed to the current vendor rather than
 * user-selectable — merging FROM the page you're looking at into some
 * other vendor would delete the vendor whose detail page you're on,
 * which is confusing enough to not offer here.
 */
export function VendorMergeDialog({
  open,
  onOpenChange,
  vendor,
  vendors,
  onMerged,
}: VendorMergeDialogProps) {
  const [fromId, setFromId] = useState<string>('');
  const utils = trpc.useUtils();

  const candidates = vendors.filter((v) => v.id !== vendor.id);

  const mergeMutation = trpc.vendors.merge.useMutation({
    onSuccess: () => {
      showSuccess('Vendors merged');
      setFromId('');
      onOpenChange(false);
      void utils.vendors.invalidate();
      onMerged?.();
    },
    onError: (error) => showError(error, 'Merging vendors'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (mergeMutation.isPending) return;
        onOpenChange(v);
        if (!v) setFromId('');
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge into {vendor.displayName}</DialogTitle>
          <DialogDescription>
            Pick the duplicate vendor to fold in. Its aliases move to "{vendor.displayName}" and the
            duplicate is deleted — payments already pointed at it are unaffected. This cannot be
            undone.
          </DialogDescription>
        </DialogHeader>

        <Select value={fromId} onValueChange={setFromId} disabled={mergeMutation.isPending}>
          <SelectTrigger>
            <SelectValue placeholder="Select a duplicate vendor" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {candidates.length === 0 && (
          <p className="text-xs text-muted-foreground">No other vendors to merge from.</p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mergeMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!fromId || mergeMutation.isPending}
            onClick={() => mergeMutation.mutate({ intoId: vendor.id, fromId })}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
