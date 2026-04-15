import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';

/**
 * RealtimeProvider
 * ================
 *
 * Maintains a WebSocket connection to the backend's real-time updates
 * service and invalidates tRPC caches when portfolio-affecting events
 * arrive, so open tabs / multiple sessions / background sync jobs all
 * reflect the latest state without needing a manual reload.
 *
 * Backend protocol
 * ----------------
 * The backend mounts its WebSocket endpoint on the root path of the same
 * host as the HTTP/tRPC API (see `apps/backend/src/index.ts`'s `.ws('/', …)`
 * handler). The client authenticates by passing the Supabase access token
 * as a `?token=…` query parameter; the server validates it against Supabase
 * and binds the connection to the user's broadcast topic `user:${userId}`.
 *
 * Messages arrive as JSON with the shape defined by `RealTimeEvent` in
 * `apps/backend/src/infrastructure/websocket/RealTimeUpdatesService.ts`.
 * The only type we act on here is `'entity_changed'` — the server emits
 * these from every mutation router (accounts/holdings/groups/vaults/…).
 *
 * Invalidation policy
 * -------------------
 * When an event arrives for any portfolio entity type, we call
 * `invalidatePortfolioQueries(utils, { refetchType: 'active' })`. Using
 * `'active'` (not `'all'`) means we only refetch queries the user can
 * currently see; data on unmounted pages is marked stale and will be
 * refetched lazily on next visit thanks to the QueryClient's
 * `refetchOnMount: true`. This avoids hammering the backend on every
 * broadcast while still keeping the visible UI fresh.
 *
 * There's intentional overlap with the mutation `onSuccess` handlers in
 * useAccountActions/useHoldingActions/etc. — they invalidate the same
 * queries optimistically in the tab that originated the mutation. React
 * Query dedupes in-flight refetches so the double-invalidation is cheap,
 * and the WebSocket path is what keeps *other* open tabs in sync.
 *
 * Connection lifecycle
 * --------------------
 * - Opens the socket as soon as a Supabase session is available.
 * - Reconnects with exponential backoff (1s → 2s → 4s → 8s → 16s max)
 *   on unexpected closures.
 * - Re-subscribes to `onAuthStateChange` and reopens the socket with the
 *   fresh access token whenever Supabase rotates it, so long-lived tabs
 *   don't get disconnected for auth expiry mid-session.
 * - Sends a client-side `ping` every 25s so the connection stays alive
 *   behind proxies with short idle timeouts. The backend responds via its
 *   `handleMessage` ping handler.
 * - Cleans up the socket, reconnect timer, and ping timer on unmount.
 */

export interface RealtimeContextValue {
  isConnected: boolean;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

// Backend entity types we care about for invalidation. Events for other
// types (user, schedule, transaction) currently have no consumers in V2.
const PORTFOLIO_ENTITY_TYPES = new Set<string>([
  'account',
  'holding',
  'institution',
  'vault',
  'group',
  'token',
]);

const MAX_RECONNECT_DELAY_MS = 16_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 25_000;

interface RealtimeProviderProps {
  children: ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const utils = trpc.useUtils();
  const [connectionStatus, setConnectionStatus] =
    useState<RealtimeContextValue['connectionStatus']>('disconnected');

  // Keep the latest `utils` reference in a ref so the message handler
  // inside the effect always invalidates against the current QueryClient
  // without forcing the effect to re-run on every render.
  const utilsRef = useRef(utils);
  useEffect(() => {
    utilsRef.current = utils;
  }, [utils]);

  useEffect(() => {
    let isUnmounted = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectAttempts = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearPingTimer = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const closeSocket = () => {
      if (socket) {
        // Remove handlers first so a deliberate close doesn't fire our
        // own onclose reconnect logic.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // Ignore — the socket may already be closing.
        }
        socket = null;
      }
      clearPingTimer();
    };

    const handleMessage = (raw: string) => {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (!message || typeof message !== 'object') return;
      const event = message as { type?: string; entityType?: string };

      // The only broadcast that should drive UI refreshes. Other message
      // types (connected, pong, subscription_updated) are bookkeeping.
      if (event.type !== 'entity_changed') return;
      if (!event.entityType || !PORTFOLIO_ENTITY_TYPES.has(event.entityType)) return;

      // Fire-and-forget — React Query handles dedup internally.
      void invalidatePortfolioQueries(utilsRef.current, { refetchType: 'active' });
    };

    const scheduleReconnect = () => {
      if (isUnmounted) return;
      clearReconnectTimer();

      // Exponential backoff capped at 16s. Full jitter avoids thundering
      // herd when the backend comes back after an outage.
      const baseDelay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempts,
        MAX_RECONNECT_DELAY_MS
      );
      const delay = Math.floor(Math.random() * baseDelay) + INITIAL_RECONNECT_DELAY_MS / 2;
      reconnectAttempts += 1;

      reconnectTimer = setTimeout(() => {
        void connect('reconnect');
      }, delay);
    };

    const connect = async (reason: 'initial' | 'reconnect' | 'token-refresh') => {
      if (isUnmounted) return;

      // Always tear down any existing socket before opening a new one —
      // token-refresh and reconnect paths both end up here.
      closeSocket();
      clearReconnectTimer();

      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) {
        setConnectionStatus('disconnected');
        return;
      }

      const accessToken = data.session.access_token;
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      // http:// → ws://, https:// → wss://
      const wsUrl = `${apiUrl.replace(/^http/, 'ws')}/?token=${encodeURIComponent(accessToken)}`;

      setConnectionStatus(reason === 'reconnect' ? 'reconnecting' : 'connecting');

      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(wsUrl);
      } catch {
        setConnectionStatus('disconnected');
        scheduleReconnect();
        return;
      }

      socket = nextSocket;

      nextSocket.onopen = () => {
        reconnectAttempts = 0;
        setConnectionStatus('connected');

        // Keep the connection alive through proxies with aggressive idle
        // timeouts. The backend's `handleMessage` understands `ping`.
        clearPingTimer();
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({ type: 'ping' }));
            } catch {
              // Ignore — next close will trigger reconnect.
            }
          }
        }, PING_INTERVAL_MS);
      };

      nextSocket.onmessage = (evt) => {
        if (typeof evt.data === 'string') {
          handleMessage(evt.data);
        }
      };

      nextSocket.onerror = (evt) => {
        // onclose will fire after this; reconnect is handled there.
        // Log so persistent connection problems are visible in devtools.
        console.warn('[realtime] WebSocket error', evt);
      };

      nextSocket.onclose = (evt) => {
        clearPingTimer();
        socket = null;

        if (isUnmounted) return;

        // Code 4401 (unauthorized) means our token was rejected. Don't
        // immediately retry with the same token — wait for auth state to
        // change (handled by the supabase subscription below).
        if (evt.code === 4401) {
          setConnectionStatus('disconnected');
          return;
        }

        setConnectionStatus('reconnecting');
        scheduleReconnect();
      };
    };

    void connect('initial');

    // Re-open the connection with the new token whenever Supabase rotates
    // the session. TOKEN_REFRESHED fires periodically for long-lived tabs;
    // SIGNED_IN / SIGNED_OUT handle explicit auth transitions.
    const { data: authSub } = supabase.auth.onAuthStateChange((eventName) => {
      if (isUnmounted) return;
      if (
        eventName === 'TOKEN_REFRESHED' ||
        eventName === 'SIGNED_IN' ||
        eventName === 'USER_UPDATED'
      ) {
        reconnectAttempts = 0;
        void connect('token-refresh');
      } else if (eventName === 'SIGNED_OUT') {
        reconnectAttempts = 0;
        closeSocket();
        clearReconnectTimer();
        setConnectionStatus('disconnected');
      }
    });

    // Wake up the connection when the tab comes back to foreground or the
    // network comes back online. Mobile Safari and background tabs often
    // drop WebSockets silently (or throttle timers enough that our ping
    // loop pauses), so a ping-based liveness check isn't enough — we have
    // to actively reconnect when the environment signals it's usable again.
    const handleWake = () => {
      if (isUnmounted) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      // If we already have an open socket, trust it. Otherwise kick off a
      // reconnect immediately instead of waiting for the backoff timer to
      // fire — the user is looking at the tab, staleness is especially
      // visible here.
      if (socket && socket.readyState === WebSocket.OPEN) return;
      reconnectAttempts = 0;
      void connect('reconnect');
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleWake);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleWake);
    }

    return () => {
      isUnmounted = true;
      authSub.subscription.unsubscribe();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleWake);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleWake);
      }
      clearReconnectTimer();
      closeSocket();
      setConnectionStatus('disconnected');
    };
  }, []);

  const value: RealtimeContextValue = {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
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
