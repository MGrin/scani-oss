import { AlertTriangle, Check, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  entityName?: string;
  entityType?: string;
  isLoading?: boolean;
  children?: React.ReactNode;
}

export function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  variant = 'danger',
  entityName,
  entityType,
  isLoading = false,
  children,
}: ConfirmationModalProps) {
  const [inputValue, setInputValue] = useState('');
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const descriptionId = useId();

  const requiresConfirmation = entityName && variant === 'danger';
  const expectedConfirmation = entityName?.toLowerCase();
  const isConfirmationValid =
    !requiresConfirmation || inputValue.toLowerCase() === expectedConfirmation;

  // Focus management
  useEffect(() => {
    if (isOpen) {
      // Focus cancel button by default for safety
      setTimeout(() => {
        cancelButtonRef.current?.focus();
      }, 100);
    }

    // Reset input when modal opens/closes
    if (!isOpen) {
      setInputValue('');
    }
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && isConfirmationValid && !isLoading) {
        e.preventDefault();
        onConfirm();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isConfirmationValid, isLoading, onClose, onConfirm]);

  const getVariantStyles = () => {
    switch (variant) {
      case 'danger':
        return {
          icon: <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />,
          confirmButtonVariant: 'destructive' as const,
        };
      case 'warning':
        return {
          icon: <AlertTriangle className="h-6 w-6 text-yellow-600" aria-hidden="true" />,
          confirmButtonVariant: 'default' as const,
        };
      case 'info':
        return {
          icon: <Check className="h-6 w-6 text-blue-600" aria-hidden="true" />,
          confirmButtonVariant: 'default' as const,
        };
      default:
        return {
          icon: <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />,
          confirmButtonVariant: 'destructive' as const,
        };
    }
  };

  const { icon, confirmButtonVariant } = getVariantStyles();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-md"
        aria-describedby={requiresConfirmation ? descriptionId : undefined}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {icon}
            <DialogTitle className="text-left">{title}</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2">{description}</DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {requiresConfirmation && (
            <div className="space-y-3">
              <Alert>
                <AlertDescription>
                  To confirm this action, please type <strong>{entityName}</strong> in the field
                  below.
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <label
                  htmlFor={inputId}
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Type "{entityName}" to confirm:
                </label>
                <input
                  id={inputId}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder={entityName}
                  aria-describedby={descriptionId}
                  disabled={isLoading}
                  autoComplete="off"
                  data-1p-ignore
                />
                <div id={descriptionId} className="text-xs text-muted-foreground">
                  This action cannot be undone. Please type the {entityType || 'item'} name exactly
                  as shown above.
                </div>
              </div>
            </div>
          )}

          {children}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            ref={cancelButtonRef}
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            className="sm:order-1"
            type="button"
          >
            <X className="h-4 w-4 mr-2" aria-hidden="true" />
            {cancelText}
          </Button>
          <Button
            ref={confirmButtonRef}
            variant={confirmButtonVariant}
            onClick={onConfirm}
            disabled={!isConfirmationValid || isLoading}
            className="sm:order-2"
            type="button"
          >
            {isLoading ? (
              <>
                <div
                  className="h-4 w-4 mr-2 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden="true"
                />
                Processing...
              </>
            ) : (
              <>
                <Check className="h-4 w-4 mr-2" aria-hidden="true" />
                {confirmText}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Hook for managing confirmation state
export function useConfirmation() {
  const [state, setState] = useState<{
    isOpen: boolean;
    config: Partial<ConfirmationModalProps>;
    resolve?: (confirmed: boolean) => void;
  }>({
    isOpen: false,
    config: {},
  });

  const confirm = (config: Omit<ConfirmationModalProps, 'isOpen' | 'onClose' | 'onConfirm'>) => {
    return new Promise<boolean>((resolve) => {
      setState({
        isOpen: true,
        config,
        resolve,
      });
    });
  };

  const handleClose = () => {
    state.resolve?.(false);
    setState({ isOpen: false, config: {} });
  };

  const handleConfirm = () => {
    state.resolve?.(true);
    setState({ isOpen: false, config: {} });
  };

  const ConfirmationComponent = () => (
    <ConfirmationModal
      {...state.config}
      isOpen={state.isOpen}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={state.config.title || 'Confirm Action'}
      description={state.config.description || 'Are you sure you want to perform this action?'}
    />
  );

  return { confirm, ConfirmationComponent };
}
