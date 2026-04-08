import { X } from 'lucide-react';

interface FilterPillProps {
  label: string;
  value: string;
  onRemove: () => void;
}

export function FilterPill({ label, value, onRemove }: FilterPillProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 pl-2.5 pr-1 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium truncate max-w-[120px]">{value}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
        aria-label={`Remove ${label} filter`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
