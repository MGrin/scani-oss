import { Grid3x3, List } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ViewToggleProps {
  viewMode: 'table' | 'cards';
  onChange: (mode: 'table' | 'cards') => void;
}

export function ViewToggle({ viewMode, onChange }: ViewToggleProps) {
  return (
    <div className="flex items-center rounded-md border">
      <Button
        variant="ghost"
        size="sm"
        className={cn('rounded-r-none border-r px-2', viewMode === 'cards' && 'bg-muted')}
        onClick={() => onChange('cards')}
        aria-label="Card view"
      >
        <Grid3x3 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn('rounded-l-none px-2', viewMode === 'table' && 'bg-muted')}
        onClick={() => onChange('table')}
        aria-label="Table view"
      >
        <List className="h-4 w-4" />
      </Button>
    </div>
  );
}
