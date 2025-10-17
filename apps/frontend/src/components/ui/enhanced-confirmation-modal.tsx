import { AlertTriangle, Info, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Alert, AlertDescription } from './alert';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Input } from './input';
import { Label } from './label';

export interface ConfirmationModalOptions {
  title: string;
  description: string;
  entityName?: string;
  entityType: 'institution' | 'account' | 'holding';
  variant?: 'danger' | 'warning' | 'info';
  confirmText?: string;
  cancelText?: string;
  requiresTextConfirmation?: boolean;
  confirmationText?: string;
  cascadeInfo?: {
    willDelete: Array<{ type: string; count: number }>;
    willAffect: Array<{ type: string; count: number }>;
  };
  warningMessages?: string[];
  onConfirm?: () => Promise<void> | void;
  onCancel?: () => void;
}

interface EnhancedConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  options: ConfirmationModalOptions;
}

export function EnhancedConfirmationModal({
  isOpen,
  onClose,
  options,
}: EnhancedConfirmationModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [confirmationInput, setConfirmationInput] = useState('');
  const inputId = useId();

  const {
    title,
    description,
    entityName = '',
    entityType,
    variant = 'danger',
    confirmText = 'Delete',
    cancelText = 'Cancel',
    requiresTextConfirmation = variant === 'danger',
    confirmationText = 'DELETE',
    cascadeInfo,
    warningMessages = [],
    onConfirm,
    onCancel,
  } = options;

  const handleConfirm = async () => {
    if (requiresTextConfirmation && confirmationInput !== confirmationText) {
      return;
    }

    try {
      setIsLoading(true);
      await onConfirm?.();
      onClose();
    } catch (error) {
      console.error('Confirmation action failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    onCancel?.();
    onClose();
  };

  const handleClose = () => {
    if (!isLoading) {
      setConfirmationInput('');
      onClose();
    }
  };

  const canConfirm = !requiresTextConfirmation || confirmationInput === confirmationText;

  const getVariantStyles = () => {
    switch (variant) {
      case 'danger':
        return {
          icon: <Trash2 className="h-6 w-6 text-red-600" />,
          titleClass: 'text-red-900 dark:text-red-100',
          buttonClass: 'bg-red-600 hover:bg-red-700 focus:ring-red-500',
        };
      case 'warning':
        return {
          icon: <AlertTriangle className="h-6 w-6 text-amber-600" />,
          titleClass: 'text-amber-900 dark:text-amber-100',
          buttonClass: 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500',
        };
      default:
        return {
          icon: <Info className="h-6 w-6 text-blue-600" />,
          titleClass: 'text-blue-900 dark:text-blue-100',
          buttonClass: 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500',
        };
    }
  };

  const { icon, titleClass, buttonClass } = getVariantStyles();

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[525px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {icon}
            <DialogTitle className={titleClass}>{title}</DialogTitle>
          </div>
          <DialogDescription className="text-left">{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Entity Details */}
          {entityName && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <strong>{entityType.charAt(0).toUpperCase() + entityType.slice(1)}:</strong>{' '}
                {entityName}
              </AlertDescription>
            </Alert>
          )}

          {/* Cascade Information */}
          {cascadeInfo &&
            (cascadeInfo.willDelete.length > 0 || cascadeInfo.willAffect.length > 0) && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-2">
                    <div className="font-medium">This action will also:</div>
                    {cascadeInfo.willDelete.length > 0 && (
                      <div>
                        <div className="font-medium text-red-800 dark:text-red-200">Delete:</div>
                        <ul className="ml-4 list-disc space-y-1">
                          {cascadeInfo.willDelete.map((item) => (
                            <li key={`delete-${item.type}`}>
                              {item.count} {item.type}
                              {item.count !== 1 ? 's' : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {cascadeInfo.willAffect.length > 0 && (
                      <div>
                        <div className="font-medium text-amber-800 dark:text-amber-200">
                          Affect:
                        </div>
                        <ul className="ml-4 list-disc space-y-1">
                          {cascadeInfo.willAffect.map((item) => (
                            <li key={`affect-${item.type}`}>
                              {item.count} {item.type}
                              {item.count !== 1 ? 's' : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            )}

          {/* Warning Messages */}
          {warningMessages.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-1">
                  {warningMessages.map((message) => (
                    <div key={`warning-${message}`}>• {message}</div>
                  ))}
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Text Confirmation */}
          {requiresTextConfirmation && (
            <div className="space-y-2">
              <Label htmlFor={inputId}>
                To confirm, type{' '}
                <code className="bg-muted px-1 py-0.5 rounded text-sm font-mono">
                  {confirmationText}
                </code>{' '}
                below:
              </Label>
              <Input
                id={inputId}
                value={confirmationInput}
                onChange={(e) => setConfirmationInput(e.target.value)}
                placeholder={`Type ${confirmationText} to confirm`}
                disabled={isLoading}
                className="font-mono"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
            {cancelText}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canConfirm || isLoading}
            className={`text-white ${buttonClass}`}
          >
            {isLoading ? 'Processing...' : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Hook for using the enhanced confirmation modal
export function useEnhancedConfirmation() {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmationModalOptions>({
    title: '',
    description: '',
    entityType: 'institution',
  });

  const confirm = (opts: ConfirmationModalOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setOptions({
        ...opts,
        onConfirm: async () => {
          await opts.onConfirm?.();
          resolve(true);
        },
        onCancel: () => {
          opts.onCancel?.();
          resolve(false);
        },
      });
      setIsOpen(true);
    });
  };

  const close = () => {
    setIsOpen(false);
  };

  const ConfirmationComponent = () => (
    <EnhancedConfirmationModal isOpen={isOpen} onClose={close} options={options} />
  );

  return { confirm, ConfirmationComponent };
}
