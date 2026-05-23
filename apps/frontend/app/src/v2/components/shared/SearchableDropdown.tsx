import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export const CREATE_NEW = '__create_new__';

interface DropdownItem {
  id: string;
  label: string;
  subtitle?: string;
  icon?: string | null;
}

interface SearchableDropdownProps {
  items: DropdownItem[];
  value: string;
  // searchText is the current input text — forwarded only on CREATE_NEW so
  // the parent can pre-fill the new-record form's name field with whatever
  // the user just typed when no match was found.
  onSelect: (id: string, searchText?: string) => void;
  placeholder: string;
  showCreateNew?: boolean;
}

export function SearchableDropdown({
  items,
  value,
  onSelect,
  placeholder,
  showCreateNew = true,
}: SearchableDropdownProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const selected = items.find((i) => i.id === value);
  const filtered = search
    ? items.filter(
        (i) =>
          i.label.toLowerCase().includes(search.toLowerCase()) ||
          i.subtitle?.toLowerCase().includes(search.toLowerCase())
      )
    : items;

  if (selected && !open) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 px-3 py-2 border rounded-md bg-muted text-sm">
          {selected.icon && (
            <img
              src={selected.icon}
              alt=""
              className="h-4 w-4 rounded-sm object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <span className="font-medium">{selected.label}</span>
          {selected.subtitle && (
            <span className="text-muted-foreground text-xs">{selected.subtitle}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs shrink-0"
          onClick={() => {
            onSelect('');
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
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[250px] overflow-y-auto">
          {showCreateNew && (
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-accent flex items-center gap-2 border-b"
              onClick={() => {
                onSelect(CREATE_NEW, search);
                setOpen(false);
                setSearch('');
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {search.trim() ? `Create new "${search.trim()}"` : 'Create new'}
            </button>
          )}
          {filtered.map((item) => (
            <button
              type="button"
              key={item.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
                setSearch('');
              }}
            >
              {item.icon && (
                <img
                  src={item.icon}
                  alt=""
                  className="h-4 w-4 rounded-sm object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <span className="font-medium">{item.label}</span>
              {item.subtitle && (
                <span className="text-muted-foreground text-xs">{item.subtitle}</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No results found</p>
          )}
        </div>
      )}
    </div>
  );
}
