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

  /**
   * Drop a named subset, keeping the rest — for a bulk action that has found
   * rows it cannot write and has to hand the reader a way past them (SC-382).
   *
   * Not `clearSelection` and not `toggleSelect` in a loop: clearing throws away
   * work the reader did, and toggling would re-SELECT an id that had already
   * been dropped, which turns a second tap into the opposite of the first.
   */
  const deselect = useCallback((ids: readonly string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isAllSelected = useMemo(
    () => ids.length > 0 && ids.every((id) => selectedIds.has(id)),
    [ids, selectedIds]
  );

  return { selectedIds, toggleSelect, deselect, selectAll, clearSelection, isAllSelected };
}
