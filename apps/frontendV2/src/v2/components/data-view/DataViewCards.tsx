import type { ReactNode } from 'react';

interface DataViewCardsProps<T> {
  data: T[];
  getId: (item: T) => string;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  renderCard: (item: T, isSelected: boolean, onSelect: () => void) => ReactNode;
  groupLabel?: string;
}

export function DataViewCards<T>({
  data,
  getId,
  selectedIds,
  onToggleSelect,
  renderCard,
  groupLabel,
}: DataViewCardsProps<T>) {
  return (
    <div>
      {groupLabel && (
        <h3 className="mb-2 mt-4 text-sm font-semibold text-muted-foreground">{groupLabel}</h3>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((item) => {
          const id = getId(item);
          return (
            <div key={id}>{renderCard(item, selectedIds.has(id), () => onToggleSelect(id))}</div>
          );
        })}
      </div>
    </div>
  );
}
