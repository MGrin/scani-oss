import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'destructive' | 'warning' | 'info';
  isLoading?: boolean;
  /**
   * Auto-focus the confirm button for destructive actions
   * Set to false for less destructive confirmations
   */
  focusConfirm?: boolean;
}

export function ConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
  isLoading = false,
  focusConfirm = false,
}: ConfirmationDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const descriptionId = React.useId();

  // Focus management for accessibility
  useEffect(() => {
    if (isOpen) {
      const timeoutId = setTimeout(() => {
        if (focusConfirm && confirmButtonRef.current) {
          confirmButtonRef.current.focus();
        } else if (cancelButtonRef.current) {
          cancelButtonRef.current.focus();
        }
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [isOpen, focusConfirm]);

  const getIcon = () => {
    switch (variant) {
      case 'destructive':
        return <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />;
      case 'warning':
        return <AlertCircle className="h-6 w-6 text-yellow-600" aria-hidden="true" />;
      default:
        return <Info className="h-6 w-6 text-blue-600" aria-hidden="true" />;
    }
  };

  const getConfirmButtonVariant = () => {
    switch (variant) {
      case 'destructive':
        return 'destructive';
      case 'warning':
        return 'default';
      default:
        return 'default';
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-[425px]"
        onKeyDown={handleKeyDown}
        role={variant === 'destructive' ? 'alertdialog' : 'dialog'}
        aria-describedby={descriptionId}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {getIcon()}
            <DialogTitle className="text-left">{title}</DialogTitle>
          </div>
          <DialogDescription id={descriptionId} className="text-left pt-2">
            {description}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <Button
            ref={cancelButtonRef}
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            className="w-full sm:w-auto"
          >
            {cancelText}
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant={getConfirmButtonVariant()}
            onClick={onConfirm}
            disabled={isLoading}
            className="w-full sm:w-auto min-w-[100px]"
          >
            {isLoading ? (
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
                <span>Processing...</span>
              </div>
            ) : (
              confirmText
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hook for managing confirmation dialogs with better UX
 */
export function useConfirmation() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [config, setConfig] = React.useState<ConfirmationDialogProps | null>(null);

  const confirm = (options: Omit<ConfirmationDialogProps, 'isOpen' | 'onClose' | 'onConfirm'>) => {
    return new Promise<boolean>((resolve) => {
      setConfig({
        ...options,
        isOpen: true,
        onClose: () => {
          setIsOpen(false);
          resolve(false);
        },
        onConfirm: () => {
          setIsOpen(false);
          resolve(true);
        },
      });
      setIsOpen(true);
    });
  };

  const ConfirmationComponent = config ? <ConfirmationDialog {...config} isOpen={isOpen} /> : null;

  return { confirm, ConfirmationComponent };
}
