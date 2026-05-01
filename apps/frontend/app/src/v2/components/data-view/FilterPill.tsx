import { X } from 'lucide-react';

interface FilterPillProps {
  label: string;
  value: string;
  onRemove: () => void;
}

export function FilterPill({ label, value, onRemove }: FilterPillProps) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/50 pl-2 pr-0.5 py-0.5 text-xs leading-none">
      <span className="text-muted-foreground mr-1">{label}:</span>
      <span className="font-medium truncate max-w-[100px]">{value}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="ml-1 rounded-full p-[3px] hover:bg-destructive/20 hover:text-destructive transition-colors flex items-center justify-center"
        aria-label={`Remove ${label} filter`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
