import { useCallback, useEffect, useMemo, useState } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { supabase } from '@/lib/supabase';

export interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  shareConnection?: boolean;
}

export function useScaniWebSocket({
  url,
  onMessage,
  onOpen,
  onClose,
  onError,
  reconnectInterval = 3000,
  maxReconnectAttempts = 5,
  shareConnection = true,
}: UseWebSocketOptions) {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [socketUrl, setSocketUrl] = useState<string | null>(null);

  // Resolve absolute URL once
  const baseUrl = useMemo(() => {
    try {
      return new URL(url, window.location.origin);
    } catch (error) {
      console.error('Invalid WebSocket URL provided:', url, error);
      return null;
    }
  }, [url]);

  // Load current session token and subscribe to changes
  useEffect(() => {
    let isMounted = true;

    async function fetchSessionToken() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (isMounted) {
        setAuthToken(session?.access_token ?? null);
      }
    }

    fetchSessionToken().catch((error) => {
      console.error('Failed to fetch Supabase session for WebSocket auth:', error);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_, session) => {
      if (isMounted) {
        setAuthToken(session?.access_token ?? null);
      }
    });

    return () => {
      isMounted = false;
      authListener.subscription?.unsubscribe();
    };
  }, []);

  // Recompute socket URL whenever token changes
  useEffect(() => {
    if (!baseUrl) {
      setSocketUrl(null);
      return;
    }

    if (!authToken) {
      setSocketUrl(null);
      return;
    }

    const authenticatedUrl = new URL(baseUrl);
    authenticatedUrl.searchParams.set('token', authToken);
    setSocketUrl(authenticatedUrl.toString());
  }, [authToken, baseUrl]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        onMessage?.(message);
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    },
    [onMessage]
  );

  const { sendJsonMessage, lastJsonMessage, readyState } = useWebSocket(
    socketUrl,
    {
      onOpen,
      onClose,
      onError,
      onMessage: handleMessage,
      shouldReconnect: () => true,
      reconnectInterval,
      reconnectAttempts: maxReconnectAttempts,
      share: shareConnection,
    },
    socketUrl !== null
  );

  const getConnectionStatus = useCallback((state: ReadyState) => {
    switch (state) {
      case ReadyState.CONNECTING:
        return 'connecting';
      case ReadyState.OPEN:
        return 'connected';
      case ReadyState.CLOSING:
      case ReadyState.CLOSED:
        return 'disconnected';
      default:
        return 'error';
    }
  }, []);

  const isConnected = readyState === ReadyState.OPEN;
  const connectionStatus = getConnectionStatus(readyState);

  const sendMessage = useCallback(
    (message: unknown) => {
      if (readyState === ReadyState.OPEN) {
        sendJsonMessage(message);
      } else {
        console.warn('WebSocket is not connected');
      }
    },
    [sendJsonMessage, readyState]
  );

  return {
    isConnected,
    connectionStatus,
    lastMessage: lastJsonMessage as WebSocketMessage | null,
    sendMessage,
  };
}
