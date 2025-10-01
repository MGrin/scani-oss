import { Building2, Coins, FileQuestion, Inbox, PieChart, Plus, Wallet } from 'lucide-react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
  variant?: 'default' | 'card';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  variant = 'default',
}: EmptyStateProps) {
  const content = (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        variant === 'card' ? 'p-12' : 'py-12 px-6',
        className
      )}
    >
      {/* Icon */}
      <div className="mb-6 p-4 rounded-full bg-muted/50 text-muted-foreground">
        {icon || <Inbox className="h-12 w-12" />}
      </div>

      {/* Title */}
      <h3 className="text-xl font-semibold text-foreground mb-2">{title}</h3>

      {/* Description */}
      <p className="text-sm text-muted-foreground mb-6 max-w-md leading-relaxed">{description}</p>

      {/* Actions */}
      {(action || secondaryAction) && (
        <div className="flex flex-col sm:flex-row gap-3">
          {action && (
            <Button onClick={action.onClick} size="lg" className="gap-2">
              {action.icon || <Plus className="h-4 w-4" />}
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button onClick={secondaryAction.onClick} variant="outline" size="lg">
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return <Card>{content}</Card>;
  }

  return content;
}

// Preset empty states for common scenarios
export function InstitutionsEmptyState() {
  const navigate = useNavigate();

  return (
    <EmptyState
      icon={<Building2 className="h-12 w-12" />}
      title="No Institutions Yet"
      description="Start by adding your first holdings. Institutions and accounts will be created automatically as you add your data."
      action={{
        label: 'Add Data',
        onClick: () => navigate('/add-data'),
        icon: <Plus className="h-4 w-4" />,
      }}
    />
  );
}

export function AccountsEmptyState() {
  const navigate = useNavigate();

  return (
    <EmptyState
      icon={<Wallet className="h-12 w-12" />}
      title="No Accounts Yet"
      description="Start by adding your data. Accounts and institutions will be created automatically as you enter your holdings."
      action={{
        label: 'Add Data',
        onClick: () => navigate('/add-data'),
        icon: <Plus className="h-4 w-4" />,
      }}
    />
  );
}

export function HoldingsEmptyState() {
  const navigate = useNavigate();

  return (
    <EmptyState
      icon={<PieChart className="h-12 w-12" />}
      title="No Holdings Yet"
      description="Start tracking your portfolio by adding your holdings. You can enter data manually or upload screenshots to automatically extract your assets."
      action={{
        label: 'Add Data',
        onClick: () => navigate('/add-data'),
        icon: <Plus className="h-4 w-4" />,
      }}
    />
  );
}

export function TokensEmptyState() {
  const navigate = useNavigate();

  return (
    <EmptyState
      icon={<Coins className="h-12 w-12" />}
      title="No Tokens Yet"
      description="Tokens will appear here once you add holdings to your portfolio. Start by adding your first holdings and the tokens will be tracked automatically."
      action={{
        label: 'Add Data',
        onClick: () => navigate('/add-data'),
        icon: <Plus className="h-4 w-4" />,
      }}
    />
  );
}

export function NoResultsEmptyState({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <EmptyState
      icon={<FileQuestion className="h-12 w-12" />}
      title="No Results Found"
      description="We couldn't find any items matching your current filters. Try adjusting your search criteria or clearing all filters."
      action={{
        label: 'Clear All Filters',
        onClick: onClearFilters,
      }}
      variant="default"
    />
  );
}
