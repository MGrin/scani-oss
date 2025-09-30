import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { useRealtimeEntitySync } from '@/hooks/useRealtimeEntitySync';

export interface RealtimeContextValue {
  isConnected: boolean;
  connectionStatus: string;
  sendMessage: (message: unknown) => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

interface RealtimeProviderProps {
  children: ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const { isConnected, connectionStatus, sendMessage } = useRealtimeEntitySync();

  return (
    <RealtimeContext.Provider value={{ isConnected, connectionStatus, sendMessage }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtimeConnection() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtimeConnection must be used within a RealtimeProvider');
  }
  return context;
}
