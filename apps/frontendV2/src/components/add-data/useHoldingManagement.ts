import { useCallback } from "react";
import type { CompleteImportData } from "@/types/addData";

interface Holding {
  id: string;
  tokenValue: string;
  amount: string;
  isExisting?: boolean;
  originalAmount?: string;
}

interface UseHoldingManagementProps {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
}

export function useHoldingManagement({
  completeImportData,
  onCompleteDataUpdate,
}: UseHoldingManagementProps) {
  const holdings = completeImportData.dataEntry?.holdings || [];

  const addHolding = useCallback(() => {
    const newHolding: Holding = {
      id: `new-${Date.now()}-${Math.random()}`,
      tokenValue: "",
      amount: "",
      isExisting: false,
    };
    const newHoldings = [...holdings, newHolding];
    onCompleteDataUpdate({
      dataEntry: {
        ...completeImportData.dataEntry,
        holdings: newHoldings,
      },
    });
  }, [holdings, completeImportData.dataEntry, onCompleteDataUpdate]);

  const removeHolding = useCallback(
    (id: string) => {
      const newHoldings = holdings.filter((h) => h.id !== id);
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings: newHoldings,
        },
      });
    },
    [holdings, completeImportData.dataEntry, onCompleteDataUpdate]
  );

  const updateHolding = useCallback(
    (id: string, field: "tokenValue" | "amount", value: string) => {
      const newHoldings = holdings.map((h) =>
        h.id === id ? { ...h, [field]: value } : h
      );
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings: newHoldings,
        },
      });
    },
    [holdings, completeImportData.dataEntry, onCompleteDataUpdate]
  );

  return {
    holdings,
    addHolding,
    removeHolding,
    updateHolding,
  };
}
