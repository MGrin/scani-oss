import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { logConfig, wsLogger } from '../utils/logger';

export type EntityType = 'institution' | 'account' | 'holding' | 'transaction' | 'user' | 'token';
export type OperationType = 'create' | 'update' | 'delete' | 'sync';

export interface RealTimeEvent {
  type: 'create' | 'update' | 'delete' | 'sync' | 'entity_changed';
  entityType: EntityType;
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
  userId: string;
  timestamp: Date;
  operationType?: OperationType;
  metadata?: {
    source?: string;
    relatedEntities?: Array<{
      type: EntityType;
      id: string;
    }>;
  };
}

export interface ClientConnection {
  id: string;
  userId: string;
  websocket: WebSocket;
  subscriptions: Set<EntityType>;
  lastSeen: Date;
}

interface RegisterConnectionOptions {
  userId: string;
  connectionId?: string;
  initialSubscriptions?: EntityType[];
  request?: IncomingMessage;
}

class RealTimeUpdatesService extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private userConnections = new Map<string, Set<string>>(); // userId -> Set of connection IDs
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.setupEventHandlers();
  }

  /**
   * Initialize the WebSocket server
   */
  initialize(server: Server, path = '/ws') {
    this.wss = new WebSocketServer({
      server,
      path,
      clientTracking: true,
    });

    this.wss.on('connection', (ws, request) => {
      this.handleConnection(ws, request);
    });

    // Setup heartbeat to remove stale connections
    this.heartbeatInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 30000); // Every 30 seconds

    if (logConfig.logWebSocketMessages) {
      wsLogger.info({ path }, 'Real-time updates service initialised');
    }
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, request: IncomingMessage) {
    // Extract user ID from query params as a last resort fallback
    const url = new URL(request.url || '', 'http://localhost');
    const userId = url.searchParams.get('userId') || 'anonymous';

    this.registerConnection(ws, {
      userId,
      request,
    });
  }

  /**
   * Register a WebSocket that has already been authenticated by the caller.
   */
  registerConnection(ws: WebSocket, options: RegisterConnectionOptions) {
    const connectionId = options.connectionId ?? this.generateConnectionId();
    const subscriptions = new Set<EntityType>(
      options.initialSubscriptions?.length
        ? options.initialSubscriptions
        : ['institution', 'account', 'holding', 'transaction']
    );

    const client: ClientConnection = {
      id: connectionId,
      userId: options.userId,
      websocket: ws,
      subscriptions,
      lastSeen: new Date(),
    };

    this.clients.set(connectionId, client);

    if (!this.userConnections.has(options.userId)) {
      this.userConnections.set(options.userId, new Set());
    }
    this.userConnections.get(options.userId)?.add(connectionId);

    ws.on('message', (data) => {
      this.handleMessage(connectionId, data);
    });

    ws.on('close', () => {
      this.handleDisconnection(connectionId);
    });

    ws.on('error', (error) => {
      wsLogger.error(
        {
          connectionId,
          error: {
            name: (error as Error).name,
            message: (error as Error).message,
          },
        },
        'WebSocket connection error'
      );
      this.handleDisconnection(connectionId);
    });

    this.sendToClient(connectionId, {
      type: 'connected',
      connectionId,
      subscriptions: Array.from(client.subscriptions),
      timestamp: new Date().toISOString(),
    });

    const remoteIp = options.request?.socket.remoteAddress
      ? ` from ${options.request.socket.remoteAddress}`
      : '';

    if (logConfig.logWebSocketMessages) {
      wsLogger.info(
        {
          connectionId,
          userId: options.userId,
          remoteIp: remoteIp || undefined,
        },
        'WebSocket client registered'
      );
    }

    return connectionId;
  }

  /**
   * Handle incoming messages from clients
   */
  private handleMessage(connectionId: string, data: RawData) {
    try {
      const client = this.clients.get(connectionId);
      if (!client) return;

      const payload = typeof data === 'string' ? data : data.toString();
      const message = JSON.parse(payload);
      client.lastSeen = new Date();

      switch (message.type) {
        case 'subscribe':
          this.handleSubscription(connectionId, message.entityTypes || []);
          break;
        case 'unsubscribe':
          this.handleUnsubscription(connectionId, message.entityTypes || []);
          break;
        case 'ping':
          this.sendToClient(connectionId, {
            type: 'pong',
            timestamp: new Date().toISOString(),
          });
          break;
        default:
          if (logConfig.logWebSocketMessages) {
            wsLogger.warn(
              { connectionId, messageType: message.type },
              'Unknown WebSocket message type'
            );
          }
      }
    } catch (error) {
      wsLogger.error(
        {
          connectionId,
          error: error instanceof Error ? error : { message: String(error) },
        },
        'Error handling WebSocket message'
      );
    }
  }

  /**
   * Handle client subscription changes
   */
  private handleSubscription(connectionId: string, entityTypes: EntityType[]) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    for (const type of entityTypes) {
      client.subscriptions.add(type);
    }

    this.sendToClient(connectionId, {
      type: 'subscription_updated',
      subscriptions: Array.from(client.subscriptions),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle client unsubscription changes
   */
  private handleUnsubscription(connectionId: string, entityTypes: EntityType[]) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    for (const type of entityTypes) {
      client.subscriptions.delete(type);
    }

    this.sendToClient(connectionId, {
      type: 'subscription_updated',
      subscriptions: Array.from(client.subscriptions),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle client disconnection
   */
  private handleDisconnection(connectionId: string) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    // Remove from user connections
    const userConnections = this.userConnections.get(client.userId);
    if (userConnections) {
      userConnections.delete(connectionId);
      if (userConnections.size === 0) {
        this.userConnections.delete(client.userId);
      }
    }

    this.clients.delete(connectionId);
    if (logConfig.logWebSocketMessages) {
      wsLogger.info({ connectionId }, 'WebSocket client disconnected');
    }
  }

  /**
   * Broadcast entity change to relevant clients
   */
  broadcast(event: RealTimeEvent) {
    const message = {
      type: 'entity_changed',
      entityType: event.entityType,
      entityId: event.entityId,
      operationType: event.operationType || event.type,
      entityIds: event.entityIds,
      data: event.data,
      timestamp: event.timestamp.toISOString(),
      metadata: event.metadata,
    };

    // Get all connections for the user
    const userConnections = this.userConnections.get(event.userId);
    if (!userConnections) {
      if (logConfig.logWebSocketMessages) {
        wsLogger.debug(
          {
            entityType: event.entityType,
            operationType: event.operationType || event.type,
            userId: event.userId,
          },
          'No active WebSocket connections for user'
        );
      }
      return;
    }

    let sentCount = 0;

    for (const connectionId of userConnections) {
      const client = this.clients.get(connectionId);
      if (!client) continue;

      // Check if client is subscribed to this entity type
      if (!client.subscriptions.has(event.entityType)) continue;

      // Check if WebSocket is still open
      if (client.websocket.readyState !== WebSocket.OPEN) {
        this.handleDisconnection(connectionId);
        continue;
      }

      try {
        client.websocket.send(JSON.stringify(message));
        sentCount++;
      } catch (error) {
        wsLogger.error(
          {
            connectionId,
            error: error instanceof Error ? error : { message: String(error) },
          },
          'Failed to send WebSocket message'
        );
        this.handleDisconnection(connectionId);
      }
    }

    if (logConfig.logWebSocketMessages) {
      wsLogger.info(
        {
          entityType: event.entityType,
          operationType: event.operationType || event.type,
          userId: event.userId,
          recipients: sentCount,
        },
        'Broadcasted real-time event'
      );
    }
  }

  /**
   * Send message to specific client
   */
  private sendToClient(connectionId: string, message: Record<string, unknown>) {
    const client = this.clients.get(connectionId);
    if (!client || client.websocket.readyState !== WebSocket.OPEN) return;

    try {
      client.websocket.send(JSON.stringify(message));
    } catch (error) {
      wsLogger.error(
        {
          connectionId,
          error: error instanceof Error ? error : { message: String(error) },
        },
        'Failed to send direct WebSocket message'
      );
      this.handleDisconnection(connectionId);
    }
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      totalConnections: this.clients.size,
      totalUsers: this.userConnections.size,
      connectionsByUser: Array.from(this.userConnections.entries()).map(
        ([userId, connections]) => ({
          userId,
          connectionCount: connections.size,
        })
      ),
    };
  }

  /**
   * Clean up stale connections
   */
  private cleanupStaleConnections() {
    const now = new Date();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [connectionId, client] of this.clients) {
      if (now.getTime() - client.lastSeen.getTime() > staleThreshold) {
        if (logConfig.logWebSocketMessages) {
          wsLogger.debug({ connectionId }, 'Cleaning up stale WebSocket connection');
        }
        this.handleDisconnection(connectionId);
      }
    }
  }

  /**
   * Generate unique connection ID
   */
  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Setup event handlers for common database events
   */
  private setupEventHandlers() {
    // These would be called by your database operations
    this.on('institution_changed', (event: RealTimeEvent) => this.broadcast(event));
    this.on('account_changed', (event: RealTimeEvent) => this.broadcast(event));
    this.on('holding_changed', (event: RealTimeEvent) => this.broadcast(event));
    this.on('transaction_changed', (event: RealTimeEvent) => this.broadcast(event));
    this.on('user_changed', (event: RealTimeEvent) => this.broadcast(event));
  }

  /**
   * Shutdown the service
   */
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.clients.clear();
    this.userConnections.clear();
  }
}

// Singleton instance
export const realTimeUpdatesService = new RealTimeUpdatesService();

/**
 * Helper function to emit entity change events
 */
export function emitEntityChange(event: Omit<RealTimeEvent, 'timestamp'>) {
  const fullEvent: RealTimeEvent = {
    ...event,
    timestamp: new Date(),
  };

  realTimeUpdatesService.emit(`${event.entityType}_changed`, fullEvent);
}

/**
 * Helper function to emit bulk changes
 */
export function emitBulkEntityChanges(
  entityType: EntityType,
  operationType: OperationType,
  entityIds: string[],
  userId: string,
  metadata?: RealTimeEvent['metadata']
) {
  emitEntityChange({
    type: 'entity_changed',
    entityType,
    operationType,
    entityIds,
    userId,
    metadata,
  });
}

/**
 * Middleware to automatically emit changes after database operations
 */
export function withRealTimeUpdates<T>(
  operation: () => Promise<T>,
  event: Omit<RealTimeEvent, 'timestamp'>
): Promise<T> {
  return operation().then((result) => {
    emitEntityChange(event);
    return result;
  });
}
