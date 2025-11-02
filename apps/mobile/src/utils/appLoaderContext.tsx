import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';

interface AppLoaderContextValue {
  dismissLoader: () => void;
  isLoaderDismissed: boolean;
}

const AppLoaderContext = createContext<AppLoaderContextValue | undefined>(undefined);

export function AppLoaderProvider({ children }: { children: ReactNode }) {
  const [isLoaderDismissed, setIsLoaderDismissed] = useState(false);

  const dismissLoader = useCallback(() => {
    setIsLoaderDismissed(true);
  }, []);

  return (
    <AppLoaderContext.Provider value={{ dismissLoader, isLoaderDismissed }}>
      {children}
    </AppLoaderContext.Provider>
  );
}

export function useAppLoader() {
  const context = useContext(AppLoaderContext);
  if (!context) {
    throw new Error('useAppLoader must be used within AppLoaderProvider');
  }
  return context;
}

