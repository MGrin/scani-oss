import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

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

    console.log(`Real-time updates service initialized on ${path}`);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, request: IncomingMessage) {
    const connectionId = this.generateConnectionId();

    // Extract user ID from query params or headers
    const url = new URL(request.url || '', 'http://localhost');
    const userId = url.searchParams.get('userId') || 'anonymous';

    const client: ClientConnection = {
      id: connectionId,
      userId,
      websocket: ws,
      subscriptions: new Set(['institution', 'account', 'holding', 'transaction']), // Default subscriptions
      lastSeen: new Date(),
    };

    this.clients.set(connectionId, client);

    // Track user connections
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set());
    }
    this.userConnections.get(userId)?.add(connectionId);

    ws.on('message', (data) => {
      this.handleMessage(connectionId, Buffer.from(data as ArrayBuffer));
    });

    ws.on('close', () => {
      this.handleDisconnection(connectionId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${connectionId}:`, error);
      this.handleDisconnection(connectionId);
    });

    // Send welcome message
    this.sendToClient(connectionId, {
      type: 'connected',
      connectionId,
      subscriptions: Array.from(client.subscriptions),
      timestamp: new Date().toISOString(),
    });

    console.log(`Client connected: ${connectionId} (user: ${userId})`);
  }

  /**
   * Handle incoming messages from clients
   */
  private handleMessage(connectionId: string, data: Buffer) {
    try {
      const client = this.clients.get(connectionId);
      if (!client) return;

      const message = JSON.parse(data.toString());
      client.lastSeen = new Date();

      switch (message.type) {
        case 'subscribe':
          this.handleSubscription(connectionId, message.entityTypes || []);
          break;
        case 'unsubscribe':
          this.handleUnsubscription(connectionId, message.entityTypes || []);
          break;
        case 'ping':
          this.sendToClient(connectionId, { type: 'pong', timestamp: new Date().toISOString() });
          break;
        default:
          console.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error handling message from client ${connectionId}:`, error);
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
    console.log(`Client disconnected: ${connectionId}`);
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
    if (!userConnections) return;

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
        console.error(`Failed to send message to client ${connectionId}:`, error);
        this.handleDisconnection(connectionId);
      }
    }

    if (sentCount > 0) {
      console.log(
        `Broadcasted ${event.entityType} ${event.operationType || event.type} to ${sentCount} clients`
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
      console.error(`Failed to send message to client ${connectionId}:`, error);
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
        console.log(`Cleaning up stale connection: ${connectionId}`);
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
