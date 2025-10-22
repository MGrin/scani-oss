import { useCallback, useMemo } from 'react';
import type { CompleteImportData } from '@/types/addData';

export function useHoldingsManagement(
  completeImportData: CompleteImportData,
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void
) {
  const addHolding = useCallback(() => {
    const holdings = completeImportData.dataEntry?.holdings || [];
    const newHoldings = [
      ...holdings,
      {
        id: `new-${Date.now()}-${Math.random()}`,
        tokenValue: '',
        amount: '',
        isExisting: false,
      },
    ];
    onCompleteDataUpdate({
      dataEntry: {
        ...completeImportData.dataEntry,
        holdings: newHoldings,
      },
    });
  }, [completeImportData.dataEntry, onCompleteDataUpdate]);

  const removeHolding = useCallback(
    (id: string) => {
      const holdings = completeImportData.dataEntry?.holdings || [];
      const newHoldings = holdings.filter((h) => h.id !== id);
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings: newHoldings,
        },
      });
    },
    [completeImportData.dataEntry, onCompleteDataUpdate]
  );

  const updateHolding = useCallback(
    (id: string, field: 'tokenValue' | 'amount', value: string) => {
      const holdings = completeImportData.dataEntry?.holdings || [];
      const newHoldings = holdings.map((h) => (h.id === id ? { ...h, [field]: value } : h));
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings: newHoldings,
        },
      });
    },
    [completeImportData.dataEntry, onCompleteDataUpdate]
  );

  const hasChanges = useMemo(() => {
    const holdings = completeImportData.dataEntry?.holdings || [];
    const newHoldings = holdings.filter((h) => !h.isExisting);
    const existingHoldings = holdings.filter((h) => h.isExisting);

    // Check if any new holdings have data
    const hasNewHoldings = newHoldings.some((h) => h.tokenValue.trim() && h.amount.trim());

    // Check if any existing holdings have changed
    const hasExistingChanges = existingHoldings.some(
      (h) => h.amount !== h.originalAmount && h.amount.trim() !== ''
    );

    return hasNewHoldings || hasExistingChanges;
  }, [completeImportData.dataEntry?.holdings]);

  return {
    addHolding,
    removeHolding,
    updateHolding,
    hasChanges,
  };
}
