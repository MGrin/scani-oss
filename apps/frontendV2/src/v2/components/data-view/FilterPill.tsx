import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

interface FilterPillProps {
  label: string;
  value: string;
  onRemove: () => void;
}

export function FilterPill({ label, value, onRemove }: FilterPillProps) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1">
      <span>
        {label}: {value}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
        aria-label={`Remove ${label} filter`}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}
