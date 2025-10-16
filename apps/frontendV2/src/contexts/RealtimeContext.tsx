import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

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
  // Simplified version - no actual WebSocket logic for now
  const value: RealtimeContextValue = {
    isConnected: false,
    connectionStatus: 'disconnected',
    sendMessage: () => {},
  };

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeConnection() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtimeConnection must be used within a RealtimeProvider');
  }
  return context;
}
