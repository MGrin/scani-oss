import { AlertTriangle, CheckCircle, Info, Loader2, X, XCircle } from 'lucide-react';
import type React from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { colorSystem, messageSystem } from '@/styles/design-system';

// Base feedback message types
export type FeedbackType = 'success' | 'error' | 'warning' | 'info';
export type FeedbackVariant = 'filled' | 'outlined' | 'subtle';

interface BaseFeedbackProps {
  type: FeedbackType;
  variant?: FeedbackVariant;
  title?: string;
  message: string;
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}

// Icon mapping for each feedback type
const feedbackIcons = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

// Base feedback component
export const FeedbackMessage: React.FC<BaseFeedbackProps> = ({
  type,
  variant = 'filled',
  title,
  message,
  dismissible = false,
  onDismiss,
  className,
  icon,
  actions,
}) => {
  const Icon = icon ? null : feedbackIcons[type];

  const getVariantClasses = () => {
    const baseClasses = colorSystem.status[type];

    switch (variant) {
      case 'filled':
        return {
          container: cn(baseClasses.bg, baseClasses.border, 'border'),
          text: baseClasses.text,
          icon: baseClasses.icon,
        };
      case 'outlined':
        return {
          container: cn('border-2', baseClasses.border, 'bg-background'),
          text: baseClasses.text,
          icon: baseClasses.icon,
        };
      case 'subtle':
        return {
          container: cn('border-l-4', baseClasses.border, 'bg-background pl-4'),
          text: baseClasses.text,
          icon: baseClasses.icon,
        };
      default:
        return {
          container: cn(baseClasses.bg, baseClasses.border, 'border'),
          text: baseClasses.text,
          icon: baseClasses.icon,
        };
    }
  };

  const classes = getVariantClasses();

  return (
    <Alert className={cn(classes.container, 'relative', className)}>
      <div className="flex items-start gap-3">
        {(Icon || icon) && (
          <div className={cn('flex-shrink-0 mt-0.5', classes.icon)}>
            {icon || (Icon && <Icon className="h-5 w-5" />)}
          </div>
        )}

        <div className="flex-1 min-w-0">
          {title && <h4 className={cn('font-medium text-sm mb-1', classes.text)}>{title}</h4>}
          <AlertDescription className={cn('text-sm', classes.text)}>{message}</AlertDescription>

          {actions && <div className="mt-3 flex gap-2">{actions}</div>}
        </div>

        {dismissible && onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className={cn('flex-shrink-0 h-6 w-6 p-0 hover:bg-transparent', classes.icon)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Dismiss</span>
          </Button>
        )}
      </div>
    </Alert>
  );
};

// Specific feedback components for different message types
export const SuccessMessage: React.FC<Omit<BaseFeedbackProps, 'type'>> = (props) => (
  <FeedbackMessage type="success" {...props} />
);

export const ErrorMessage: React.FC<Omit<BaseFeedbackProps, 'type'>> = (props) => (
  <FeedbackMessage type="error" {...props} />
);

export const WarningMessage: React.FC<Omit<BaseFeedbackProps, 'type'>> = (props) => (
  <FeedbackMessage type="warning" {...props} />
);

export const InfoMessage: React.FC<Omit<BaseFeedbackProps, 'type'>> = (props) => (
  <FeedbackMessage type="info" {...props} />
);

// Loading message component
interface LoadingMessageProps {
  message?: string;
  variant?: 'inline' | 'overlay' | 'card';
  className?: string;
}

export const LoadingMessage: React.FC<LoadingMessageProps> = ({
  message = messageSystem.info.loading,
  variant = 'inline',
  className,
}) => {
  const baseClasses = 'flex items-center gap-3';

  const variantClasses = {
    inline: 'p-4',
    overlay: 'fixed inset-0 bg-background/80 backdrop-blur-sm z-50 justify-center items-center',
    card: 'p-8 border rounded-lg bg-card text-card-foreground shadow-sm',
  };

  return (
    <div className={cn(baseClasses, variantClasses[variant], className)}>
      <Loader2 className="h-5 w-5 animate-spin text-primary" />
      <span className="text-sm text-muted-foreground">{message}</span>
    </div>
  );
};

// Empty state component
interface EmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  message?: string;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title = 'No data available',
  message = messageSystem.info.emptyState,
  action,
  className,
}) => {
  return (
    <div
      className={cn('flex flex-col items-center justify-center py-12 px-6 text-center', className)}
    >
      {icon && <div className="mb-4 text-muted-foreground">{icon}</div>}

      <h3 className="text-lg font-medium text-foreground mb-2">{title}</h3>

      <p className="text-sm text-muted-foreground mb-6 max-w-md">{message}</p>

      {action && action}
    </div>
  );
};

// Toast notification hook (for use with react-hot-toast or similar)
export interface ToastOptions {
  type?: FeedbackType;
  duration?: number;
  position?: 'top-center' | 'top-right' | 'bottom-center' | 'bottom-right';
  dismissible?: boolean;
}

// Standardized feedback messages using our message system
export const feedbackMessages = {
  // CRUD Success Messages
  institutionCreated: () => ({
    type: 'success' as const,
    message: messageSystem.success.create.institution,
  }),
  institutionUpdated: () => ({
    type: 'success' as const,
    message: messageSystem.success.update.institution,
  }),
  institutionDeleted: () => ({
    type: 'success' as const,
    message: messageSystem.success.delete.institution,
  }),

  accountCreated: () => ({
    type: 'success' as const,
    message: messageSystem.success.create.account,
  }),
  accountUpdated: () => ({
    type: 'success' as const,
    message: messageSystem.success.update.account,
  }),
  accountDeleted: () => ({
    type: 'success' as const,
    message: messageSystem.success.delete.account,
  }),

  holdingCreated: () => ({
    type: 'success' as const,
    message: messageSystem.success.create.holding,
  }),
  holdingUpdated: () => ({
    type: 'success' as const,
    message: messageSystem.success.update.holding,
  }),
  holdingDeleted: () => ({
    type: 'success' as const,
    message: messageSystem.success.delete.holding,
  }),

  transactionCreated: () => ({
    type: 'success' as const,
    message: messageSystem.success.create.transaction,
  }),
  transactionUpdated: () => ({
    type: 'success' as const,
    message: messageSystem.success.update.transaction,
  }),
  transactionDeleted: () => ({
    type: 'success' as const,
    message: messageSystem.success.delete.transaction,
  }),

  settingsSaved: () => ({
    type: 'success' as const,
    message: messageSystem.success.update.settings,
  }),

  // Error Messages
  createFailed: (entity: string) => ({
    type: 'error' as const,
    message: `❌ Failed to create ${entity}`,
  }),
  updateFailed: (entity: string) => ({
    type: 'error' as const,
    message: `❌ Failed to update ${entity}`,
  }),
  deleteFailed: (entity: string) => ({
    type: 'error' as const,
    message: `❌ Failed to delete ${entity}`,
  }),

  networkError: () => ({
    type: 'error' as const,
    message: messageSystem.error.network,
  }),
  serverError: () => ({
    type: 'error' as const,
    message: messageSystem.error.server,
  }),
  validationError: () => ({
    type: 'error' as const,
    message: messageSystem.error.validation,
  }),

  // Warning Messages
  unsavedChanges: () => ({
    type: 'warning' as const,
    message: messageSystem.warning.unsavedChanges,
  }),
  duplicateName: () => ({
    type: 'warning' as const,
    message: messageSystem.warning.duplicateName,
  }),
  dataLoss: () => ({
    type: 'warning' as const,
    message: messageSystem.warning.dataLoss,
  }),

  // Info Messages
  syncing: () => ({
    type: 'info' as const,
    message: messageSystem.info.syncing,
  }),
  offline: () => ({
    type: 'info' as const,
    message: messageSystem.info.offline,
  }),
  reconnected: () => ({
    type: 'info' as const,
    message: messageSystem.info.reconnected,
  }),
};

// Utility function to get standardized confirmation message
export const getConfirmationMessage = (
  _action: string,
  entityType: string,
  entityName?: string
) => {
  const baseMessage =
    messageSystem.confirmation.delete[entityType as keyof typeof messageSystem.confirmation.delete];
  return entityName ? baseMessage.replace('this', `"${entityName}"`) : baseMessage;
};

// Status indicator component
interface StatusIndicatorProps {
  status: 'online' | 'offline' | 'syncing' | 'error';
  showLabel?: boolean;
  className?: string;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  showLabel = false,
  className,
}) => {
  const statusConfig = {
    online: {
      color: 'bg-green-500',
      label: 'Online',
      pulse: false,
    },
    offline: {
      color: 'bg-gray-500',
      label: 'Offline',
      pulse: false,
    },
    syncing: {
      color: 'bg-blue-500',
      label: 'Syncing',
      pulse: true,
    },
    error: {
      color: 'bg-red-500',
      label: 'Error',
      pulse: true,
    },
  };

  const config = statusConfig[status];

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className={cn('h-2 w-2 rounded-full', config.color, config.pulse && 'animate-pulse')} />
      {showLabel && <span className="text-xs text-muted-foreground">{config.label}</span>}
    </div>
  );
};

// Progress indicator component
interface ProgressIndicatorProps {
  progress: number; // 0-100
  showLabel?: boolean;
  variant?: 'linear' | 'circular';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progress,
  showLabel = true,
  variant = 'linear',
  size = 'md',
  className,
}) => {
  const clampedProgress = Math.max(0, Math.min(100, progress));

  const sizeClasses = {
    sm: variant === 'linear' ? 'h-1' : 'h-6 w-6',
    md: variant === 'linear' ? 'h-2' : 'h-8 w-8',
    lg: variant === 'linear' ? 'h-3' : 'h-12 w-12',
  };

  if (variant === 'circular') {
    const radius = size === 'sm' ? 10 : size === 'md' ? 14 : 22;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (clampedProgress / 100) * circumference;

    return (
      <div className={cn('inline-flex items-center gap-2', className)}>
        <div className={sizeClasses[size]}>
          <svg
            className="transform -rotate-90 w-full h-full"
            viewBox="0 0 44 44"
            aria-hidden="true"
          >
            <title>Progress indicator showing {Math.round(clampedProgress)}% completion</title>
            <circle
              cx="22"
              cy="22"
              r={radius}
              stroke="hsl(var(--muted))"
              strokeWidth="2"
              fill="none"
            />
            <circle
              cx="22"
              cy="22"
              r={radius}
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className="transition-all duration-300"
            />
          </svg>
        </div>
        {showLabel && <span className="text-sm font-medium">{Math.round(clampedProgress)}%</span>}
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)}>
      <div className={cn('bg-muted rounded-full overflow-hidden', sizeClasses[size])}>
        <div
          className="bg-primary h-full transition-all duration-300 ease-out"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>
      {showLabel && (
        <div className="flex justify-between text-xs text-muted-foreground mt-1">
          <span>Progress</span>
          <span>{Math.round(clampedProgress)}%</span>
        </div>
      )}
    </div>
  );
};
