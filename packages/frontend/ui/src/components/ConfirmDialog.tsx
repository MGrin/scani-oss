import { Loader2 } from 'lucide-react';
import { useDismissOnHide } from '../hooks/useDismissOnHide';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  isPending,
}: ConfirmDialogProps) {
  // The other half of SC-124: v3's inline confirms are `ConfirmAction`, but
  // this dialog is still the shape for a confirmation raised from a page
  // header rather than from a row, and a question left standing over a
  // backgrounded app is answerable out of context whichever shape it wears.
  // Every variant, not only `destructive` — the default ones gate an AI call
  // or a re-parse, which is a commitment too.
  useDismissOnHide(open && !isPending, () => onOpenChange(false));

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={() => {
              onConfirm();
            }}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 me-2 animate-spin" />
                {confirmLabel}
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
