import { useCallback, useMemo, useState } from 'react';

export function useBulkSelection(ids: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(ids));
  }, [ids]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isAllSelected = useMemo(
    () => ids.length > 0 && ids.every((id) => selectedIds.has(id)),
    [ids, selectedIds]
  );

  return { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected };
}
