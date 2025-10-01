import { useToast as useToastOriginal } from '@/hooks/use-toast';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastOptions {
  title?: string;
  description: string;
  type?: ToastType;
  duration?: number;
}

export function useEnhancedToast() {
  const { toast } = useToastOriginal();

  const showToast = ({ title, description, type = 'info', duration = 5000 }: ToastOptions) => {
    const variant = type === 'error' ? 'destructive' : type === 'success' ? 'success' : 'default';

    toast({
      title: title || getDefaultTitle(type),
      description,
      variant,
      duration,
    });
  };

  // Convenience methods
  const success = (description: string, title?: string) => {
    showToast({ description, title, type: 'success' });
  };

  const error = (description: string, title?: string) => {
    showToast({ description, title, type: 'error', duration: 7000 });
  };

  const info = (description: string, title?: string) => {
    showToast({ description, title, type: 'info' });
  };

  const warning = (description: string, title?: string) => {
    showToast({ description, title, type: 'warning' });
  };

  return {
    toast: showToast,
    success,
    error,
    info,
    warning,
  };
}

function getDefaultTitle(type: ToastType): string {
  switch (type) {
    case 'success':
      return 'Success';
    case 'error':
      return 'Error';
    case 'warning':
      return 'Warning';
    case 'info':
      return 'Information';
    default:
      return 'Notification';
  }
}

// Validation error helper
export function formatValidationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'An unexpected error occurred. Please try again.';
}
