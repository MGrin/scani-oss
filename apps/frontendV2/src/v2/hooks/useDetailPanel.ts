import { createContext, useCallback, useContext, useState } from 'react';

export type EntityType = 'holding' | 'account' | 'institution' | 'vault';

interface DetailPanelState {
  isOpen: boolean;
  entityType: EntityType | null;
  entityId: string | null;
}

interface DetailPanelContext extends DetailPanelState {
  open: (type: EntityType, id: string) => void;
  close: () => void;
}

const DetailPanelCtx = createContext<DetailPanelContext | null>(null);

export const DetailPanelProvider = DetailPanelCtx.Provider;

export function useDetailPanelState(): DetailPanelContext {
  const [state, setState] = useState<DetailPanelState>({
    isOpen: false,
    entityType: null,
    entityId: null,
  });

  const open = useCallback((type: EntityType, id: string) => {
    setState({ isOpen: true, entityType: type, entityId: id });
  }, []);

  const close = useCallback(() => {
    setState({ isOpen: false, entityType: null, entityId: null });
  }, []);

  return { ...state, open, close };
}

export function useDetailPanel(): DetailPanelContext {
  const ctx = useContext(DetailPanelCtx);
  if (!ctx) throw new Error('useDetailPanel must be used within DetailPanelProvider');
  return ctx;
}
