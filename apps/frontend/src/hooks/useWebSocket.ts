import { useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';

export interface WebSocketMessage {
  type: string;
  data?: unknown;
  message?: string;
  timestamp: string;
}

interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useScaniWebSocket({
  url,
  onMessage,
  onOpen,
  onClose,
  onError,
  reconnectInterval = 3000,
  maxReconnectAttempts = 5,
}: UseWebSocketOptions) {
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

  const { sendJsonMessage, lastJsonMessage, readyState } = useWebSocket(url, {
    onOpen: onOpen,
    onClose: onClose,
    onError: onError,
    onMessage: handleMessage,
    shouldReconnect: () => true,
    reconnectInterval: reconnectInterval,
    reconnectAttempts: maxReconnectAttempts,
    share: false, // Don't share connection across components
  });

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
