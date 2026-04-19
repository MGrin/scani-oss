import { EventEmitter } from 'node:events';
import { logConfig, wsLogger } from '@scani/core/utils/logger';
import type { Redis } from 'ioredis';
import { Container, Service } from 'typedi';

export type EntityType =
  | 'institution'
  | 'account'
  | 'holding'
  | 'transaction'
  | 'user'
  | 'token'
  | 'schedule'
  | 'schedule_step'
  | 'group'
  | 'vault'
  | 'job';
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
  } & Record<string, unknown>;
}

export interface ClientConnection {
  id: string;
  userId: string;
  subscriptions: Set<EntityType>;
  lastSeen: Date;
}

interface RegisterConnectionOptions {
  userId: string;
  connectionId?: string;
  initialSubscriptions?: EntityType[];
}

@Service()
export class RealTimeUpdatesService extends EventEmitter {
  // Use Elysia's pub/sub instead of managing WebSocket connections directly
  private clients = new Map<string, ClientConnection>();
  private userConnections = new Map<string, Set<string>>(); // userId -> Set of connection IDs
  private heartbeatInterval: NodeJS.Timeout | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type not well defined, using any for app instance
  private elysiaApp: any = null; // Store Elysia app instance for pub/sub

  // Redis-backed cross-instance pub/sub (optional). When set by
  // configureRedisPubSub(), broadcast() publishes to Redis instead of
  // directly to the local Elysia topic, and a subscriber forwards
  // inbound messages from Redis back to local connections.
  private redisPublisher: Redis | null = null;
  private readonly redisChannelPrefix = 'rt:user:';

  constructor() {
    super();
    this.setupEventHandlers();
  }

  /**
   * Wire a Redis connection so entity changes fan out across backend
   * instances. Both the producer (publish) and subscriber (consume) roles
   * are handled here; the caller provides one connection for publishing and
   * a second (via .duplicate()) for blocking subscribe.
   */
  configureRedisPubSub(publisher: Redis, subscriber: Redis): void {
    this.redisPublisher = publisher;
    const pattern = `${this.redisChannelPrefix}*`;
    void subscriber.psubscribe(pattern, (err) => {
      if (err) {
        wsLogger.error({ error: err.message, pattern }, 'Failed to psubscribe to Redis WS channel');
        return;
      }
      wsLogger.info({ pattern }, '✅ Subscribed to Redis WS fan-out');
    });
    subscriber.on('pmessage', (_p, channel, rawMessage) => {
      // Channel format: rt:user:<userId>. Extract userId to build local topic.
      const userId = channel.slice(this.redisChannelPrefix.length);
      if (!userId) return;
      this.publishLocal(userId, rawMessage);
    });
  }

  private publishLocal(userId: string, payload: string): void {
    const topic = `user:${userId}`;
    if (this.elysiaApp?.server) {
      this.elysiaApp.server.publish(topic, payload);
    }
  }

  /**
   * Set Elysia app instance for pub/sub functionality
   */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type not well defined, using any for app instance
  setElysiaApp(app: any) {
    this.elysiaApp = app;
    wsLogger.info('✅ Elysia app instance registered with realTimeUpdatesService');
  }

  /**
   * Initialize heartbeat for cleanup
   * Note: WebSocket connections are managed by Elysia, not this service
   */
  initialize() {
    // Prevent multiple initializations
    if (this.heartbeatInterval) {
      wsLogger.warn(
        'Real-time updates service already initialized, skipping duplicate initialization'
      );
      return;
    }

    // Setup heartbeat to remove stale connections
    this.heartbeatInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 30000); // Every 30 seconds

    if (logConfig.logWebSocketMessages) {
      wsLogger.info('✅ Real-time updates service initialized (Elysia mode)');
    }
  }

  /**
   * Register a connection (metadata only - actual WebSocket managed by Elysia)
   * This is called from the Elysia WebSocket 'open' handler
   */
  registerConnection(options: RegisterConnectionOptions) {
    const connectionId = options.connectionId ?? this.generateConnectionId();
    const subscriptions = new Set<EntityType>(
      options.initialSubscriptions?.length
        ? options.initialSubscriptions
        : ['institution', 'account', 'holding', 'transaction', 'token']
    );

    const client: ClientConnection = {
      id: connectionId,
      userId: options.userId,
      subscriptions,
      lastSeen: new Date(),
    };

    this.clients.set(connectionId, client);

    if (!this.userConnections.has(options.userId)) {
      this.userConnections.set(options.userId, new Set());
    }
    this.userConnections.get(options.userId)?.add(connectionId);

    if (logConfig.logWebSocketMessages) {
      wsLogger.info(
        {
          connectionId,
          userId: options.userId,
        },
        'WebSocket client registered'
      );
    }

    return connectionId;
  }

  /**
   * Handle incoming messages from clients
   * Called from Elysia WebSocket 'message' handler
   */
  handleMessage(connectionId: string, data: unknown) {
    try {
      const client = this.clients.get(connectionId);
      if (!client) return;

      // Elysia/Bun auto-parses JSON WebSocket messages, so `data` may already
      // be a plain object rather than a string. Handle both cases.
      const message =
        typeof data === 'object' && data !== null && !(data instanceof Buffer)
          ? (data as Record<string, unknown>)
          : JSON.parse(typeof data === 'string' ? data : String(data));
      client.lastSeen = new Date();

      switch (message.type) {
        case 'subscribe':
          this.handleSubscription(connectionId, message.entityTypes || []);
          break;
        case 'unsubscribe':
          this.handleUnsubscription(connectionId, message.entityTypes || []);
          break;
        case 'ping':
          // Send pong response via pub/sub to user's topic
          if (this.elysiaApp?.server && client.userId) {
            this.elysiaApp.server.publish(
              `user:${client.userId}`,
              JSON.stringify({
                type: 'pong',
                timestamp: new Date().toISOString(),
              })
            );
          }
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

    // Send subscription update via pub/sub to user's topic
    if (this.elysiaApp?.server) {
      this.elysiaApp.server.publish(
        `user:${client.userId}`,
        JSON.stringify({
          type: 'subscription_updated',
          subscriptions: Array.from(client.subscriptions),
          timestamp: new Date().toISOString(),
        })
      );
    }
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

    // Send subscription update via pub/sub to user's topic
    if (this.elysiaApp?.server) {
      this.elysiaApp.server.publish(
        `user:${client.userId}`,
        JSON.stringify({
          type: 'subscription_updated',
          subscriptions: Array.from(client.subscriptions),
          timestamp: new Date().toISOString(),
        })
      );
    }
  }

  /**
   * Handle client disconnection
   * Called from Elysia WebSocket 'close' handler
   */
  handleDisconnection(connectionId: string) {
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
   * Broadcast entity change to relevant clients using Elysia pub/sub
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
    if (!userConnections || userConnections.size === 0) {
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

    // Deliver to all subscribers of this topic. In Redis mode, fan out via
    // Redis so every backend instance that holds a WS client for this user
    // gets the message. In memory mode, publish directly to the local
    // Elysia topic.
    const topic = `user:${event.userId}`;
    const payload = JSON.stringify(message);

    if (this.redisPublisher) {
      void this.redisPublisher.publish(`${this.redisChannelPrefix}${event.userId}`, payload);
    } else if (this.elysiaApp?.server) {
      this.elysiaApp.server.publish(topic, payload);
    } else {
      wsLogger.warn('Elysia app not set, cannot broadcast');
      return;
    }

    if (logConfig.logWebSocketMessages) {
      wsLogger.info(
        {
          entityType: event.entityType,
          operationType: event.operationType || event.type,
          userId: event.userId,
          topic,
          connectionCount: userConnections.size,
          transport: this.redisPublisher ? 'redis' : 'local',
        },
        'Broadcasted real-time event via pub/sub'
      );
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
    return `conn_${crypto.randomUUID()}`;
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

    this.clients.clear();
    this.userConnections.clear();
    this.elysiaApp = null;
  }
}

/**
 * Helper function to emit entity change events
 * Uses TypeDI Container to get service instance
 */
export function emitEntityChange(event: Omit<RealTimeEvent, 'timestamp'>) {
  const fullEvent: RealTimeEvent = {
    ...event,
    timestamp: new Date(),
  };

  const service = Container.get(RealTimeUpdatesService);
  service.emit(`${event.entityType}_changed`, fullEvent);
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
