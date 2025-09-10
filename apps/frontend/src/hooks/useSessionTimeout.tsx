import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/hooks/use-toast';

export interface SessionTimeoutConfig {
  timeoutMinutes: number; // Total session timeout in minutes
  warningMinutes: number; // When to show warning before timeout
  checkIntervalSeconds: number; // How often to check for activity
  activities: string[]; // Events that count as user activity
}

export interface SessionTimeoutState {
  isActive: boolean;
  remainingTime: number; // in seconds
  showWarning: boolean;
  lastActivity: Date;
}

const DEFAULT_CONFIG: SessionTimeoutConfig = {
  timeoutMinutes: 30,
  warningMinutes: 5,
  checkIntervalSeconds: 30,
  activities: ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click', 'keydown'],
};

export function useSessionTimeout(
  config: Partial<SessionTimeoutConfig> = {},
  onTimeout?: () => void
) {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const [state, setState] = useState<SessionTimeoutState>({
    isActive: true,
    remainingTime: fullConfig.timeoutMinutes * 60,
    showWarning: false,
    lastActivity: new Date(),
  });

  const timeoutRef = useRef<NodeJS.Timeout>();
  const warningRef = useRef<NodeJS.Timeout>();
  const checkIntervalRef = useRef<NodeJS.Timeout>();
  const lastActivityRef = useRef<Date>(new Date());

  // Update activity timestamp
  const updateActivity = useCallback(() => {
    const now = new Date();
    lastActivityRef.current = now;

    setState((prev) => ({
      ...prev,
      lastActivity: now,
      remainingTime: fullConfig.timeoutMinutes * 60,
      showWarning: false,
    }));

    // Clear existing timeouts
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (warningRef.current) clearTimeout(warningRef.current);

    // Set new warning timeout
    const warningTime = (fullConfig.timeoutMinutes - fullConfig.warningMinutes) * 60 * 1000;
    warningRef.current = setTimeout(() => {
      setState((prev) => ({ ...prev, showWarning: true }));

      // Show toast warning
      toast({
        title: 'Session Expiring Soon',
        description: `Your session will expire in ${fullConfig.warningMinutes} minutes due to inactivity. Click to stay logged in.`,
        duration: fullConfig.warningMinutes * 60 * 1000, // Show for remaining time
      });
    }, warningTime);

    // Set new timeout
    const timeoutTime = fullConfig.timeoutMinutes * 60 * 1000;
    timeoutRef.current = setTimeout(() => {
      setState((prev) => ({
        ...prev,
        isActive: false,
        remainingTime: 0,
        showWarning: false,
      }));

      // Show final warning toast
      toast({
        title: 'Session Expired',
        description:
          'You have been automatically logged out due to inactivity. Please log in again to continue.',
        variant: 'destructive',
        duration: Infinity, // Keep until manually dismissed
      });

      // Trigger logout callback if provided
      onTimeout?.();
    }, timeoutTime);
  }, [fullConfig.timeoutMinutes, fullConfig.warningMinutes, onTimeout]);

  // Check remaining time periodically
  const checkRemainingTime = useCallback(() => {
    const now = new Date();
    const elapsedSeconds = Math.floor((now.getTime() - lastActivityRef.current.getTime()) / 1000);
    const remaining = Math.max(0, fullConfig.timeoutMinutes * 60 - elapsedSeconds);

    setState((prev) => ({
      ...prev,
      remainingTime: remaining,
    }));

    return remaining;
  }, [fullConfig.timeoutMinutes]);

  // Activity event handler
  const handleActivity = useCallback(
    (_event: Event) => {
      // Ignore if already inactive
      if (!state.isActive) return;

      // Throttle activity updates (max once per second)
      const now = new Date();
      const timeSinceLastUpdate = now.getTime() - lastActivityRef.current.getTime();

      if (timeSinceLastUpdate > 1000) {
        updateActivity();
      }
    },
    [state.isActive, updateActivity]
  );

  // Setup activity listeners
  useEffect(() => {
    const listeners = fullConfig.activities.map((activity) => {
      const handler = (event: Event) => handleActivity(event);
      document.addEventListener(activity, handler, { passive: true });
      return { activity, handler };
    });

    // Start interval check
    checkIntervalRef.current = setInterval(() => {
      const remaining = checkRemainingTime();

      if (remaining <= 0) {
        setState((prev) => ({ ...prev, isActive: false }));
      }
    }, fullConfig.checkIntervalSeconds * 1000);

    // Initialize activity
    updateActivity();

    return () => {
      // Remove event listeners
      listeners.forEach(({ activity, handler }) => {
        document.removeEventListener(activity, handler);
      });

      // Clear intervals and timeouts
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (warningRef.current) clearTimeout(warningRef.current);
    };
  }, [
    fullConfig.activities,
    fullConfig.checkIntervalSeconds,
    handleActivity,
    updateActivity,
    checkRemainingTime,
  ]);

  // Manual session extension
  const extendSession = useCallback(() => {
    updateActivity();
    // Note: toast.dismiss() is not available in the current version
    // Toast will auto-dismiss based on duration
  }, [updateActivity]);

  // Manual logout
  const logout = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isActive: false,
      remainingTime: 0,
      showWarning: false,
    }));

    // Clear all timeouts
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (warningRef.current) clearTimeout(warningRef.current);
    if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);

    onTimeout?.();
  }, [onTimeout]);

  // Format remaining time for display
  const formatRemainingTime = useCallback((seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }, []);

  // Get warning message based on remaining time
  const getWarningMessage = useCallback(() => {
    const minutes = Math.floor(state.remainingTime / 60);

    if (minutes <= 0) {
      return 'Session expired';
    }

    if (minutes <= fullConfig.warningMinutes) {
      return `Session expires in ${formatRemainingTime(state.remainingTime)}`;
    }

    return null;
  }, [state.remainingTime, fullConfig.warningMinutes, formatRemainingTime]);

  return {
    ...state,
    extendSession,
    logout,
    formatRemainingTime: () => formatRemainingTime(state.remainingTime),
    warningMessage: getWarningMessage(),
    config: fullConfig,
  };
}

// Session timeout provider context
import { createContext, useContext } from 'react';

interface SessionTimeoutContextType extends ReturnType<typeof useSessionTimeout> {
  onTimeout?: () => void;
}

const SessionTimeoutContext = createContext<SessionTimeoutContextType | null>(null);

export function SessionTimeoutProvider({
  children,
  onTimeout,
  config = {},
}: {
  children: React.ReactNode;
  onTimeout?: () => void;
  config?: Partial<SessionTimeoutConfig>;
}) {
  const sessionTimeout = useSessionTimeout(config, onTimeout);

  return (
    <SessionTimeoutContext.Provider value={{ ...sessionTimeout, onTimeout }}>
      {children}
    </SessionTimeoutContext.Provider>
  );
}

export function useSessionTimeoutContext() {
  const context = useContext(SessionTimeoutContext);
  if (!context) {
    throw new Error('useSessionTimeoutContext must be used within a SessionTimeoutProvider');
  }
  return context;
}

// Session status indicator component
export function SessionStatusIndicator() {
  const { isActive, showWarning, warningMessage, extendSession } = useSessionTimeoutContext();

  if (!isActive) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-destructive text-destructive-foreground px-4 py-3 text-sm font-medium text-center shadow-lg">
        Session Expired - Please log in again
      </div>
    );
  }

  if (showWarning && warningMessage) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-100 text-yellow-800 px-4 py-3 text-sm font-medium flex items-center justify-between shadow-lg">
        <span>{warningMessage}</span>
        <button
          type="button"
          onClick={extendSession}
          className="ml-3 bg-yellow-200 hover:bg-yellow-300 px-3 py-1 rounded text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          Stay Logged In
        </button>
      </div>
    );
  }

  return null;
}
