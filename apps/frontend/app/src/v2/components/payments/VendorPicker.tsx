import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { showError } from '@scani/ui/ui/use-toast';
import { Loader2, Plus, Store } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

interface VendorPickerProps {
  value: string;
  /** Display label for `value` — carried separately so a prefilled edit doesn't need `vendors.list` to have loaded first. */
  valueLabel?: string;
  onSelect: (vendorId: string, displayName: string) => void;
  disabled?: boolean;
}

/**
 * Picks an existing vendor or creates one inline via `vendors.create`.
 * Without this, `PaymentCreatePage` is a dead end — `payments.create`
 * requires a `vendorId` and nothing else in the app can produce one (see
 * Task 15's plan entry).
 */
export function VendorPicker({ value, valueLabel, onSelect, disabled }: VendorPickerProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const { data: vendors, isLoading } = trpc.vendors.list.useQuery();
  const createMutation = trpc.vendors.create.useMutation({
    onSuccess: (vendor) => {
      void utils.vendors.invalidate();
      onSelect(vendor.id, vendor.displayName);
      setSearch('');
      setOpen(false);
    },
    onError: (error) => showError(error, 'Creating vendor'),
  });

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const items = vendors ?? [];
  const filtered = search.trim()
    ? items.filter((v) => v.displayName.toLowerCase().includes(search.trim().toLowerCase()))
    : items;

  if (value) {
    const selectedLabel = items.find((v) => v.id === value)?.displayName ?? valueLabel ?? value;
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 px-3 py-2 border rounded-md bg-muted text-sm">
          <Store className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{selectedLabel}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs shrink-0"
          disabled={disabled}
          onClick={() => {
            onSelect('', '');
            setOpen(true);
            setSearch('');
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <Label className="text-xs mb-1 block">Vendor</Label>
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search vendors..."
        disabled={disabled || createMutation.isPending}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[280px] overflow-y-auto">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-accent flex items-center gap-2 border-b disabled:opacity-50"
            disabled={!search.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate({ displayName: search.trim() })}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {search.trim() ? `Create new "${search.trim()}"` : 'Type a name to create a vendor'}
          </button>
          {isLoading && <p className="px-3 py-2 text-xs text-muted-foreground">Loading vendors…</p>}
          {!isLoading &&
            filtered.map((vendor) => (
              <button
                type="button"
                key={vendor.id}
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                onClick={() => {
                  onSelect(vendor.id, vendor.displayName);
                  setSearch('');
                  setOpen(false);
                }}
              >
                <span className="font-medium truncate">{vendor.displayName}</span>
                {vendor.category && (
                  <span className="text-muted-foreground text-xs">{vendor.category}</span>
                )}
              </button>
            ))}
          {!isLoading && filtered.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matching vendors</p>
          )}
        </div>
      )}
    </div>
  );
}
